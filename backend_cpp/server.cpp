#include "server.hpp"

#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>

#include <deque>
#include <iostream>

namespace webscope {

namespace beast = boost::beast;
namespace websocket = beast::websocket;

namespace {

struct Out {
    bool binary;
    std::string data;
};

std::shared_ptr<const Out> textMsg(const json& j) {
    return std::make_shared<const Out>(Out{false, dumpJson(j)});
}

json errorMsg(const std::string& message) {
    return {{"type", "error"}, {"message", message}};
}

}  // namespace

// ============================================================================
// One connected browser
// ============================================================================
class WsSession : public std::enable_shared_from_this<WsSession> {
public:
    WsSession(tcp::socket&& socket, Server& server)
        : ws_(std::move(socket)), server_(server), registry_(server.registry()) {
        registry_->sessions.insert(this);
    }

    ~WsSession() { registry_->sessions.erase(this); }

    void run() {
        ws_.set_option(websocket::stream_base::timeout::suggested(beast::role_type::server));
        ws_.set_option(websocket::stream_base::decorator([](websocket::response_type& res) {
            res.set(beast::http::field::server, "webscope-backend");
        }));
        ws_.read_message_max(1 << 20);  // clients only send small JSON commands
        ws_.async_accept(beast::bind_front_handler(&WsSession::onAccept, shared_from_this()));
    }

    // Queue a message. Binary frames are dropped / the capture aborted on overflow.
    void enqueue(std::shared_ptr<const Out> msg) {
        if (closed_) return;

        if (msg->binary) {
            if (overflowed_) return;  // drop until the client starts a new capture
            if (queuedBytes_ + msg->data.size() > server_.maxQueuedBytes()) {
                overflowed_ = true;
                for (auto& id : started_) server_.devices().stop(id);
                enqueue(textMsg(errorMsg(
                    "client too slow - capture aborted (send buffer full)")));
                return;
            }
        }
        queuedBytes_ += msg->data.size();
        queue_.push_back(std::move(msg));
        if (!writing_) doWrite();
    }

    void sendText(const json& j) { enqueue(textMsg(j)); }
    void sendBinary(std::string frame) {
        enqueue(std::make_shared<const Out>(Out{true, std::move(frame)}));
    }

private:
    void onAccept(beast::error_code ec) {
        if (ec) return cleanup();
        std::cerr << "[ws] client connected (" << registry_->sessions.size() << " total)\n";
        sendText({{"type", "devices"}, {"devices", server_.devices().deviceList()}});
        doRead();
    }

    void doRead() {
        ws_.async_read(buffer_, beast::bind_front_handler(&WsSession::onRead, shared_from_this()));
    }

    void onRead(beast::error_code ec, std::size_t) {
        if (ec) return cleanup();  // includes websocket::error::closed

        if (ws_.got_text()) {
            handleMessage(beast::buffers_to_string(buffer_.data()));
        } else {
            sendText(errorMsg("binary messages are not supported"));
        }
        buffer_.consume(buffer_.size());
        doRead();
    }

    void doWrite() {
        writing_ = true;
        const auto& front = queue_.front();
        ws_.text(!front->binary);
        ws_.async_write(net::buffer(front->data),
                        beast::bind_front_handler(&WsSession::onWrite, shared_from_this()));
    }

    void onWrite(beast::error_code ec, std::size_t) {
        if (ec) return cleanup();
        queuedBytes_ -= queue_.front()->data.size();
        queue_.pop_front();
        if (queue_.empty()) {
            writing_ = false;
        } else {
            doWrite();
        }
    }

    void cleanup() {
        if (closed_) return;
        closed_ = true;
        for (auto& id : started_) server_.devices().stop(id);  // nobody is listening any more
        started_.clear();
        queue_.clear();
        queuedBytes_ = 0;
        beast::error_code ignored;
        beast::get_lowest_layer(ws_).socket().close(ignored);  // also cancels pending ops
        std::cerr << "[ws] client disconnected\n";
    }

    // ---- protocol ---------------------------------------------------------
    void handleMessage(const std::string& text) {
        json msg = json::parse(text, nullptr, /*allow_exceptions=*/false);
        if (msg.is_discarded() || !msg.is_object() || !msg.contains("type") ||
            !msg["type"].is_string()) {
            return sendText(errorMsg("invalid message"));
        }

        try {
            const std::string type = msg["type"];
            if (type == "start") {
                handleStart(msg);
            } else if (type == "stop") {
                server_.devices().stop(msg.value("deviceId", std::string()));
            } else if (type == "scan") {
                auto weak = weak_from_this();
                server_.rescan([weak](std::string err) {
                    if (err.empty()) return;
                    if (auto self = weak.lock()) self->sendText(errorMsg(err));
                });
            } else {
                sendText(errorMsg("unknown message type: " + type));
            }
        } catch (const std::exception& e) {  // e.g. wrong JSON field types
            sendText(errorMsg(std::string("bad request: ") + e.what()));
        }
    }

    void handleStart(const json& msg) {
        StartParams params;
        params.deviceId = msg.at("deviceId").get<std::string>();
        params.samplerate = msg.value("samplerate", uint64_t{0});
        params.numSamples = msg.value("numSamples", uint64_t{0});
        if (msg.contains("channels") && msg["channels"].is_array()) {
            params.channels = msg["channels"].get<std::vector<std::string>>();
        }

        // These lambdas run on the sigrok worker thread: only post, never touch `this`.
        auto weak = weak_from_this();
        net::io_context& ioc = server_.ioc();
        Server& server = server_;

        AcquisitionSink sink;
        sink.onStarted = [weak, &ioc](json meta) {
            net::post(ioc, [weak, meta = std::move(meta)] {
                if (auto self = weak.lock()) self->sendText(meta);
            });
        };
        sink.onData = [weak, &ioc](std::string frame) {
            net::post(ioc, [weak, frame = std::move(frame)]() mutable {
                if (auto self = weak.lock()) self->sendBinary(std::move(frame));
            });
        };
        sink.onError = [weak, &ioc](std::string message) {
            net::post(ioc, [weak, message = std::move(message)] {
                std::cerr << "[capture] error: " << message << "\n";
                if (auto self = weak.lock()) self->sendText(errorMsg(message));
            });
        };
        sink.onDone = [weak, &ioc, &server](json info) {
            net::post(ioc, [weak, &server, info = std::move(info)] {
                if (auto self = weak.lock()) self->started_.erase(info.value("deviceId", ""));
                server.broadcastText(dumpJson(info));  // everyone learns the device is free
            });
        };

        overflowed_ = false;
        std::string err = server_.devices().start(std::move(params), std::move(sink));
        if (!err.empty()) return sendText(errorMsg(err));
        started_.insert(msg["deviceId"].get<std::string>());
    }

    websocket::stream<beast::tcp_stream> ws_;
    Server& server_;
    std::shared_ptr<Registry> registry_;
    beast::flat_buffer buffer_;

    std::deque<std::shared_ptr<const Out>> queue_;
    size_t queuedBytes_ = 0;
    bool writing_ = false;
    bool closed_ = false;
    bool overflowed_ = false;
    std::set<std::string> started_;  // captures started by this client

    friend class Server;
};

// ============================================================================
// Server
// ============================================================================
Server::Server(net::io_context& ioc, tcp::endpoint endpoint, DeviceManager& devices,
               size_t maxQueuedBytes)
    : ioc_(ioc), acceptor_(ioc), endpoint_(endpoint), devices_(devices), maxQueued_(maxQueuedBytes) {}

Server::~Server() {
    if (scanThread_.joinable()) scanThread_.join();
}

void Server::run() {
    acceptor_.open(endpoint_.protocol());
    acceptor_.set_option(net::socket_base::reuse_address(true));
    acceptor_.bind(endpoint_);
    acceptor_.listen(net::socket_base::max_listen_connections);
    std::cerr << "[ws] listening on " << endpoint_ << "\n";
    doAccept();
}

void Server::doAccept() {
    acceptor_.async_accept([this](beast::error_code ec, tcp::socket socket) {
        if (!ec) {
            beast::error_code ignored;
            socket.set_option(tcp::no_delay(true), ignored);
            std::make_shared<WsSession>(std::move(socket), *this)->run();
        } else if (ec == net::error::operation_aborted) {
            return;
        }
        doAccept();
    });
}

void Server::broadcastText(const std::string& text) {
    auto msg = std::make_shared<const Out>(Out{false, text});
    for (WsSession* s : registry_->sessions) s->enqueue(msg);
}

void Server::broadcastDevices() {
    broadcastText(dumpJson({{"type", "devices"}, {"devices", devices_.deviceList()}}));
}

void Server::rescan(std::function<void(std::string)> done) {
    if (scanning_) return done("scan already in progress");
    if (devices_.busy()) return done("cannot scan while a capture is running");

    if (scanThread_.joinable()) scanThread_.join();
    scanning_ = true;
    scanThread_ = std::thread([this, done = std::move(done)]() mutable {
        std::string err;
        try {
            err = devices_.scan();
        } catch (const std::exception& e) {
            err = e.what();
        }
        net::post(ioc_, [this, err, done = std::move(done)] {
            scanning_ = false;
            if (err.empty()) broadcastDevices();
            done(err);
        });
    });
}

}  // namespace webscope
