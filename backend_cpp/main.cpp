#include "server.hpp"

#include <boost/asio/signal_set.hpp>

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using namespace webscope;

static void usage(const char* argv0) {
    std::cerr
        << "Usage: " << argv0 << " [options]\n"
        << "  --port N             WebSocket port (default 8080)\n"
        << "  --bind ADDR          address to listen on (default 127.0.0.1, use 0.0.0.0 for all)\n"
        << "  --driver NAME[:CONN] sigrok driver to scan, repeatable. CONN is e.g. /dev/ttyUSB0\n"
        << "                       (default: demo and fx2lafw)\n"
        << "  --max-queue-mb N     per-client send buffer before a capture is aborted (default 64)\n"
        << "  --list-drivers       print the drivers this libsigrok build supports and exit\n";
}

int main(int argc, char** argv) {
    unsigned short port = 8080;
    std::string bindAddr = "127.0.0.1";
    size_t maxQueueMb = 64;
    bool listDrivers = false;
    std::vector<DriverSpec> drivers;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) {
                usage(argv[0]);
                std::exit(2);
            }
            return argv[++i];
        };
        if (a == "--port") {
            port = static_cast<unsigned short>(std::stoi(next()));
        } else if (a == "--bind") {
            bindAddr = next();
        } else if (a == "--driver") {
            std::string v = next();
            auto colon = v.find(':');
            DriverSpec spec;
            spec.name = v.substr(0, colon);
            if (colon != std::string::npos) {
                spec.conn = v.substr(colon + 1);
                if (spec.conn.rfind("conn=", 0) == 0) spec.conn = spec.conn.substr(5);
            }
            drivers.push_back(spec);
        } else if (a == "--max-queue-mb") {
            maxQueueMb = static_cast<size_t>(std::stoul(next()));
        } else if (a == "--list-drivers") {
            listDrivers = true;
        } else {
            usage(argv[0]);
            return a == "-h" || a == "--help" ? 0 : 2;
        }
    }
    if (drivers.empty()) drivers = {{"demo", ""}, {"fx2lafw", ""}};

    try {
        DeviceManager devices(drivers);
        if (listDrivers) {
            for (auto& n : devices.availableDrivers()) std::cout << n << "\n";
            return 0;
        }

        std::cerr << "[sigrok] scanning...\n";
        std::string err = devices.scan();
        if (!err.empty()) std::cerr << "[sigrok] " << err << "\n";
        std::cerr << "[sigrok] found " << devices.deviceList().size() << " device(s)\n";

        net::io_context ioc(1);  // single io thread, see server.hpp
        Server server(ioc, tcp::endpoint(net::ip::make_address(bindAddr), port), devices,
                      maxQueueMb * 1024 * 1024);
        server.run();

        net::signal_set signals(ioc, SIGINT, SIGTERM);
        signals.async_wait([&](const boost::system::error_code&, int) {
            std::cerr << "[main] shutting down\n";
            devices.stopAll();
            ioc.stop();
        });

        ioc.run();
    } catch (const std::exception& e) {
        std::cerr << "fatal: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
