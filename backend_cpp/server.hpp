// server.hpp - WebSocket server (Boost.Beast) exposing the DeviceManager to the browser.
//
// Threading: everything in here runs on ONE io_context thread. sigrok worker threads
// only ever net::post() into the io_context, so no locks are needed in this file.
//
// Protocol (JSON text frames unless noted)
//   client -> server
//     {"type":"start","deviceId":"demo:0","samplerate":1000000,"numSamples":100000,
//      "channels":["D0","D1"]}          (samplerate/numSamples/channels optional)
//     {"type":"stop","deviceId":"demo:0"}
//     {"type":"scan"}                   (rescan hardware)
//   server -> client
//     {"type":"devices","devices":[...]}   on connect and after every scan (broadcast)
//     {"type":"started", ...}              to the client that started a capture
//     binary frames                        see sigrok_backend.hpp for the layout
//     {"type":"done", ...}                 broadcast when a capture ends
//     {"type":"error","message":"..."}
#pragma once

#include "sigrok_backend.hpp"

#include <boost/asio.hpp>

#include <cstddef>
#include <functional>
#include <memory>
#include <set>
#include <string>
#include <thread>

namespace webscope {

namespace net = boost::asio;
using tcp = net::ip::tcp;

class WsSession;

// Shared between the server and every session so sessions can safely deregister
// themselves even while the io_context is being torn down.
struct Registry {
    std::set<WsSession*> sessions;
};

class Server {
public:
    Server(net::io_context& ioc, tcp::endpoint endpoint, DeviceManager& devices,
           size_t maxQueuedBytes);
    ~Server();

    void run();  // bind, listen, start accepting; throws on bind errors

    void broadcastText(const std::string& text);
    void broadcastDevices();

    // Rescans hardware on a helper thread; `done` is called on the io thread with
    // an error message or "" on success (and the device list is broadcast on success).
    void rescan(std::function<void(std::string)> done);

    DeviceManager& devices() { return devices_; }
    net::io_context& ioc() { return ioc_; }
    size_t maxQueuedBytes() const { return maxQueued_; }
    std::shared_ptr<Registry> registry() { return registry_; }

private:
    void doAccept();

    net::io_context& ioc_;
    tcp::acceptor acceptor_;
    tcp::endpoint endpoint_;
    DeviceManager& devices_;
    size_t maxQueued_;
    std::shared_ptr<Registry> registry_ = std::make_shared<Registry>();
    std::thread scanThread_;
    bool scanning_ = false;
};

}  // namespace webscope
