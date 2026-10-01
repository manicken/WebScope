#include "sigrok_backend.hpp"

#include <algorithm>
#include <cstring>
#include <iostream>
#include <set>
#include <stdexcept>

namespace webscope {

std::string dumpJson(const json& j) {
    return j.dump(-1, ' ', false, json::error_handler_t::replace);
}

namespace {

void put16(std::string& s, size_t pos, uint16_t v) {
    s[pos] = static_cast<char>(v & 0xff);
    s[pos + 1] = static_cast<char>((v >> 8) & 0xff);
}
void put32(std::string& s, size_t pos, uint32_t v) {
    for (int i = 0; i < 4; ++i) s[pos + i] = static_cast<char>((v >> (8 * i)) & 0xff);
}
void put64(std::string& s, size_t pos, uint64_t v) {
    for (int i = 0; i < 8; ++i) s[pos + i] = static_cast<char>((v >> (8 * i)) & 0xff);
}

void writeHeader(std::string& frame, uint8_t kind, uint8_t unitsize, uint16_t channels,
                 uint32_t samples, uint64_t offset) {
    frame[0] = static_cast<char>(kind);
    frame[1] = static_cast<char>(unitsize);
    put16(frame, 2, channels);
    put32(frame, 4, samples);
    put64(frame, 8, offset);
}

std::string channelTypeName(const sigrok::Channel& ch) {
    const sigrok::ChannelType* t = ch.type();
    if (t == sigrok::ChannelType::LOGIC) return "logic";
    if (t == sigrok::ChannelType::ANALOG) return "analog";
    return t->name();
}

json describeChannels(const std::shared_ptr<sigrok::HardwareDevice>& dev) {
    json arr = json::array();
    for (auto& ch : dev->channels()) {
        arr.push_back({{"index", ch->index()},
                       {"name", ch->name()},
                       {"type", channelTypeName(*ch)},
                       {"enabled", ch->enabled()}});
    }
    return arr;
}

// Returns either an array of rates, {"min","max","step"}, or null if the device
// does not report its samplerates.
json describeSamplerates(const std::shared_ptr<sigrok::HardwareDevice>& dev) {
    try {
        auto keys = dev->driver()->config_keys();
        (void)keys;
        Glib::VariantContainerBase list = dev->config_list(sigrok::ConfigKey::SAMPLERATE);
        using Dict = std::map<Glib::ustring, Glib::VariantBase>;
        auto dict = Glib::VariantBase::cast_dynamic<Glib::Variant<Dict>>(list).get();

        auto it = dict.find("samplerates");
        if (it != dict.end()) {
            auto v = Glib::VariantBase::cast_dynamic<Glib::Variant<std::vector<guint64>>>(it->second);
            json arr = json::array();
            for (guint64 r : v.get()) arr.push_back(static_cast<uint64_t>(r));
            return arr;
        }
        it = dict.find("samplerate-steps");
        if (it != dict.end()) {
            auto v = Glib::VariantBase::cast_dynamic<Glib::Variant<std::vector<guint64>>>(it->second);
            auto s = v.get();
            if (s.size() == 3) {
                return {{"min", static_cast<uint64_t>(s[0])},
                        {"max", static_cast<uint64_t>(s[1])},
                        {"step", static_cast<uint64_t>(s[2])}};
            }
        }
    } catch (const std::exception&) {
        // device without samplerate list, or an unexpected variant layout
    }
    return nullptr;
}

json describe(const std::string& id, const std::shared_ptr<sigrok::HardwareDevice>& dev) {
    std::string vendor = dev->vendor();
    std::string model = dev->model();
    std::string name = vendor.empty() ? model : (model.empty() ? vendor : vendor + " " + model);
    if (name.empty()) name = dev->driver()->name();

    return {{"id", id},
            {"name", name},
            {"vendor", vendor},
            {"model", model},
            {"version", dev->version()},
            {"driver", dev->driver()->name()},
            {"connection", dev->connection_id()},
            {"channels", describeChannels(dev)},
            {"samplerates", describeSamplerates(dev)}};
}

std::optional<uint64_t> readU64(const std::shared_ptr<sigrok::HardwareDevice>& dev,
                                const sigrok::ConfigKey* key) {
    try {
        auto v = Glib::VariantBase::cast_dynamic<Glib::Variant<guint64>>(dev->config_get(key));
        return static_cast<uint64_t>(v.get());
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

}  // namespace

// ============================================================================
// Acquisition
// ============================================================================

Acquisition::Acquisition(std::shared_ptr<sigrok::Context> ctx,
                         std::shared_ptr<sigrok::HardwareDevice> dev, std::string deviceId,
                         StartParams params, AcquisitionSink sink)
    : ctx_(std::move(ctx)),
      dev_(std::move(dev)),
      deviceId_(std::move(deviceId)),
      params_(std::move(params)),
      sink_(std::move(sink)) {}

Acquisition::~Acquisition() {
    stop();
    join();
}

void Acquisition::start() {
    thread_ = std::thread([this] { run(); });
}

void Acquisition::join() {
    if (thread_.joinable() && thread_.get_id() != std::this_thread::get_id()) thread_.join();
}

void Acquisition::stop() {
    std::lock_guard<std::mutex> lock(mtx_);
    stopRequested_ = true;
    if (started_ && session_) {
        try {
            session_->stop();  // documented as safe to call from another thread
        } catch (const std::exception& e) {
            std::cerr << "[sigrok] stop: " << e.what() << "\n";
        }
    }
}

void Acquisition::run() {
    std::string error;
    std::shared_ptr<sigrok::Session> session;
    bool opened = false;

    try {
        session = ctx_->create_session();

        dev_->open();  // may upload firmware, can take a couple of seconds
        opened = true;

        if (params_.channels) {
            std::set<std::string> wanted(params_.channels->begin(), params_.channels->end());
            for (auto& ch : dev_->channels()) {
                ch->set_enabled(wanted.count(ch->name()) > 0);
                wanted.erase(ch->name());
            }
            if (!wanted.empty()) throw std::runtime_error("unknown channel: " + *wanted.begin());
        }
        if (params_.samplerate) {
            dev_->config_set(sigrok::ConfigKey::SAMPLERATE,
                             Glib::Variant<guint64>::create(params_.samplerate));
        }
        // Settings stick to the device object between captures, so always set the limit
        // (0 = unlimited). Devices without a sample limit simply reject the 0.
        try {
            dev_->config_set(sigrok::ConfigKey::LIMIT_SAMPLES,
                             Glib::Variant<guint64>::create(params_.numSamples));
        } catch (const std::exception&) {
            if (params_.numSamples) throw;
        }

        session->add_device(dev_);
        session->add_datafeed_callback(
            [this](std::shared_ptr<sigrok::Device>, std::shared_ptr<sigrok::Packet> packet) {
                onPacket(packet);
            });

        {
            std::lock_guard<std::mutex> lock(mtx_);
            session_ = session;
            if (!stopRequested_) {
                session->start();
                started_ = true;
            }
        }

        if (started_) {
            json channels = json::array();
            for (auto& ch : dev_->channels()) {
                if (!ch->enabled()) continue;
                channels.push_back({{"index", ch->index()},
                                    {"name", ch->name()},
                                    {"type", channelTypeName(*ch)}});
            }
            auto rate = readU64(dev_, sigrok::ConfigKey::SAMPLERATE);
            if (sink_.onStarted) {
                sink_.onStarted({{"type", "started"},
                                 {"deviceId", deviceId_},
                                 {"samplerate", rate ? json(*rate) : json(nullptr)},
                                 {"numSamples", params_.numSamples},
                                 {"channels", channels}});
            }
            session->run();  // blocks until the device is done or stop() is called
        }
    } catch (const std::exception& e) {
        error = e.what();
    }

    {
        std::lock_guard<std::mutex> lock(mtx_);
        started_ = false;
        session_.reset();
    }
    try {
        if (session) session->remove_devices();
        if (opened) dev_->close();
    } catch (const std::exception& e) {
        std::cerr << "[sigrok] cleanup: " << e.what() << "\n";
    }

    bool stopped;
    {
        std::lock_guard<std::mutex> lock(mtx_);
        stopped = stopRequested_;
    }
    if (!error.empty() && sink_.onError) sink_.onError(error);
    if (sink_.onDone) {
        sink_.onDone({{"type", "done"},
                      {"deviceId", deviceId_},
                      {"samples", totalSamples_},
                      {"stopped", stopped},
                      {"ok", error.empty()}});
    }
    finished_ = true;
}

void Acquisition::onPacket(const std::shared_ptr<sigrok::Packet>& packet) {
    const sigrok::PacketType* type = packet->type();

    if (type == sigrok::PacketType::LOGIC) {
        auto logic = std::dynamic_pointer_cast<sigrok::Logic>(packet->payload());
        if (!logic) return;
        const size_t unit = logic->unit_size();
        if (unit == 0) return;
        const size_t samples = logic->data_length() / unit;
        if (samples == 0) return;

        std::string frame(kFrameHeaderSize + samples * unit, '\0');
        writeHeader(frame, kFrameLogic, static_cast<uint8_t>(unit), 0,
                    static_cast<uint32_t>(samples), logicOffset_);
        std::memcpy(&frame[kFrameHeaderSize], logic->data_pointer(), samples * unit);
        logicOffset_ += samples;
        totalSamples_ += samples;
        if (sink_.onData) sink_.onData(std::move(frame));

    } else if (type == sigrok::PacketType::ANALOG) {
        auto analog = std::dynamic_pointer_cast<sigrok::Analog>(packet->payload());
        if (!analog) return;
        const size_t nch = analog->channels().size();
        const size_t samples = analog->num_samples();
        if (nch == 0 || samples == 0) return;

        std::string frame(kFrameHeaderSize + samples * nch * sizeof(float), '\0');
        writeHeader(frame, kFrameAnalog, sizeof(float), static_cast<uint16_t>(nch),
                    static_cast<uint32_t>(samples), analogOffset_);
        // Converts whatever the driver delivers (int/float, any width) to float32.
        // Native byte order is used, which is little-endian on x86 and ARM Linux/Windows.
        analog->get_data_as_float(reinterpret_cast<float*>(&frame[kFrameHeaderSize]));
        analogOffset_ += samples;
        totalSamples_ += samples;
        if (sink_.onData) sink_.onData(std::move(frame));
    }
    // HEADER / END / TRIGGER / META packets are not needed by the frontend.
}

// ============================================================================
// DeviceManager
// ============================================================================

DeviceManager::DeviceManager(std::vector<DriverSpec> drivers)
    : ctx_(sigrok::Context::create()), drivers_(std::move(drivers)) {
    ctx_->set_log_level(sigrok::LogLevel::WARN);
}

DeviceManager::~DeviceManager() {
    stopAll();
}

std::vector<std::string> DeviceManager::availableDrivers() const {
    std::vector<std::string> names;
    for (auto& kv : ctx_->drivers()) names.push_back(kv.first);
    return names;
}

std::string DeviceManager::scan() {
    if (scanning_.exchange(true)) return "scan already in progress";
    struct Reset {
        std::atomic<bool>& f;
        ~Reset() { f = false; }
    } reset{scanning_};

    {
        std::lock_guard<std::mutex> lock(mtx_);
        reapLocked();
        if (!running_.empty()) return "cannot scan while a capture is running";
    }

    std::map<std::string, Entry> found;
    auto drivers = ctx_->drivers();

    for (const auto& spec : drivers_) {
        auto it = drivers.find(spec.name);
        if (it == drivers.end()) {
            std::cerr << "[sigrok] driver not available in this libsigrok build: " << spec.name << "\n";
            continue;
        }
        try {
            std::map<const sigrok::ConfigKey*, Glib::VariantBase> opts;
            if (!spec.conn.empty()) {
                opts[sigrok::ConfigKey::CONN] = Glib::Variant<Glib::ustring>::create(spec.conn);
            }
            auto devs = it->second->scan(opts);
            int index = 0;
            for (auto& dev : devs) {
                std::string conn = dev->connection_id();
                std::string id = spec.name + ":" + (conn.empty() ? std::to_string(index) : conn);
                ++index;
                for (int n = 2; found.count(id); ++n) id = id + "#" + std::to_string(n);
                found[id] = Entry{dev, describe(id, dev)};
            }
        } catch (const std::exception& e) {
            std::cerr << "[sigrok] scan " << spec.name << " failed: " << e.what() << "\n";
        }
    }

    std::lock_guard<std::mutex> lock(mtx_);
    devices_ = std::move(found);
    return "";
}

json DeviceManager::deviceList() const {
    std::lock_guard<std::mutex> lock(mtx_);
    json arr = json::array();
    for (auto& kv : devices_) arr.push_back(kv.second.info);
    return arr;
}

bool DeviceManager::busy() {
    std::lock_guard<std::mutex> lock(mtx_);
    reapLocked();
    return !running_.empty();
}

void DeviceManager::reapLocked() {
    for (auto it = running_.begin(); it != running_.end();) {
        if (it->second->finished()) {
            it->second->join();
            it = running_.erase(it);
        } else {
            ++it;
        }
    }
}

std::string DeviceManager::start(StartParams params, AcquisitionSink sink) {
    if (scanning_) return "a device scan is in progress";

    std::lock_guard<std::mutex> lock(mtx_);
    reapLocked();

    auto it = devices_.find(params.deviceId);
    if (it == devices_.end()) return "unknown device: " + params.deviceId;
    if (running_.count(params.deviceId)) return "device is already capturing";

    const std::string id = params.deviceId;
    auto acq = std::make_shared<Acquisition>(ctx_, it->second.dev, id, std::move(params),
                                             std::move(sink));
    running_[id] = acq;
    acq->start();
    return "";
}

void DeviceManager::stop(const std::string& deviceId) {
    std::shared_ptr<Acquisition> acq;
    {
        std::lock_guard<std::mutex> lock(mtx_);
        auto it = running_.find(deviceId);
        if (it != running_.end()) acq = it->second;
    }
    if (acq) acq->stop();  // the worker finishes on its own; reapLocked() joins it later
}

void DeviceManager::stopAll() {
    std::map<std::string, std::shared_ptr<Acquisition>> taken;
    {
        std::lock_guard<std::mutex> lock(mtx_);
        taken.swap(running_);
    }
    for (auto& kv : taken) kv.second->stop();
    for (auto& kv : taken) kv.second->join();
}

}  // namespace webscope
