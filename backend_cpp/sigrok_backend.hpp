// sigrok_backend.hpp - thin layer between WebScope and libsigrok (C++ bindings).
//
// DeviceManager : scans drivers, describes devices as JSON, owns running acquisitions.
// Acquisition   : one capture run on one device, executed on its own worker thread.
//
// All AcquisitionSink callbacks are invoked on the acquisition's worker thread.
// They must not touch the network directly - the server posts them to its io_context.
#pragma once

#include <libsigrokcxx/libsigrokcxx.hpp>
#include <nlohmann/json.hpp>

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace webscope {

using json = nlohmann::json;

// Serialise JSON without ever throwing on invalid UTF-8 (device strings can be garbage).
std::string dumpJson(const json& j);

// ---------------------------------------------------------------------------
// Binary frame format (server -> client), all integers little-endian:
//
//   offset size  field
//   0      1     kind      1 = logic, 2 = analog
//   1      1     unitsize  logic: bytes per sample; analog: 4 (float32)
//   2      2     channels  logic: 0 (see "started" message); analog: channel count
//   4      4     samples   number of samples in this frame (per channel for analog)
//   8      8     offset    index of the first sample of this frame (per kind)
//   16     ...   payload   logic: samples*unitsize raw bytes (bit N = channel index N)
//                          analog: samples*channels float32, interleaved per sample
// ---------------------------------------------------------------------------
constexpr size_t kFrameHeaderSize = 16;
constexpr uint8_t kFrameLogic = 1;
constexpr uint8_t kFrameAnalog = 2;

struct DriverSpec {
    std::string name;  // sigrok driver name, e.g. "demo", "fx2lafw"
    std::string conn;  // optional connection string, e.g. "/dev/ttyUSB0" (serial drivers)
};

struct StartParams {
    std::string deviceId;
    uint64_t samplerate = 0;  // 0 = keep the device default
    uint64_t numSamples = 0;  // 0 = no limit (run until stopped)
    std::optional<std::vector<std::string>> channels;  // names to enable; unset = keep defaults
};

struct AcquisitionSink {
    std::function<void(json)> onStarted;           // meta about the stream, sent once
    std::function<void(std::string)> onData;       // one complete binary frame
    std::function<void(json)> onDone;              // always called exactly once
    std::function<void(std::string)> onError;      // zero or more times, before onDone
};

class Acquisition {
public:
    Acquisition(std::shared_ptr<sigrok::Context> ctx,
                std::shared_ptr<sigrok::HardwareDevice> dev,
                std::string deviceId, StartParams params, AcquisitionSink sink);
    ~Acquisition();

    Acquisition(const Acquisition&) = delete;
    Acquisition& operator=(const Acquisition&) = delete;

    void start();   // spawns the worker thread
    void stop();    // thread-safe, non-blocking, idempotent
    void join();
    bool finished() const { return finished_.load(); }

private:
    void run();
    void onPacket(const std::shared_ptr<sigrok::Packet>& packet);

    std::shared_ptr<sigrok::Context> ctx_;
    std::shared_ptr<sigrok::HardwareDevice> dev_;
    std::string deviceId_;
    StartParams params_;
    AcquisitionSink sink_;

    std::thread thread_;
    std::atomic<bool> finished_{false};

    std::mutex mtx_;  // guards session_, started_, stopRequested_
    std::shared_ptr<sigrok::Session> session_;
    bool started_ = false;
    bool stopRequested_ = false;

    // only touched from the worker thread
    uint64_t logicOffset_ = 0;
    uint64_t analogOffset_ = 0;
    uint64_t totalSamples_ = 0;
};

class DeviceManager {
public:
    explicit DeviceManager(std::vector<DriverSpec> drivers);
    ~DeviceManager();

    std::vector<std::string> availableDrivers() const;

    // Blocking. Returns "" on success or an error message. Refuses while captures are running.
    std::string scan();

    json deviceList() const;  // JSON array, see describe() in the .cpp for the shape

    // Returns "" on success or an error message. Sink callbacks run on a worker thread.
    std::string start(StartParams params, AcquisitionSink sink);
    void stop(const std::string& deviceId);
    void stopAll();  // stops and joins everything
    bool busy();

private:
    struct Entry {
        std::shared_ptr<sigrok::HardwareDevice> dev;
        json info;
    };

    void reapLocked();

    std::shared_ptr<sigrok::Context> ctx_;
    std::vector<DriverSpec> drivers_;

    mutable std::mutex mtx_;
    std::map<std::string, Entry> devices_;
    std::map<std::string, std::shared_ptr<Acquisition>> running_;
    std::atomic<bool> scanning_{false};
};

}  // namespace webscope
