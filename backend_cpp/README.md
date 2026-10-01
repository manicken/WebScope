# webscope-backend

C++17 WebSocket backend for WebScope: Boost.Beast + libsigrok (C++ bindings).

## Build

Linux (Debian/Ubuntu):

    sudo apt install build-essential cmake pkg-config libboost-dev \
         libsigrokcxx-dev nlohmann-json3-dev
    cmake -B build && cmake --build build -j

Windows: easiest via MSYS2 (mingw-w64-x86_64-{toolchain,cmake,boost,libsigrok,nlohmann-json}),
same cmake commands. Devices need the WinUSB driver (Zadig).

## Run

    ./build/webscope-backend --driver demo --driver fx2lafw --port 8080

`demo` is sigrok's built-in fake device, so you can test without hardware.
Serial devices: `--driver <serial-driver>:/dev/ttyUSB0`.
`--list-drivers` shows what your libsigrok build supports.

On Linux, install sigrok's udev rules (`60-libsigrok.rules`, in the libsigrok package or
sigrok-util) so USB devices work without root, and sigrok-firmware for fx2lafw clones.

The server binds to 127.0.0.1 by default. Use `--bind 0.0.0.0` to expose it on the network
(there is no authentication).

## Protocol

See the header comments in `src/server.hpp` (JSON messages) and `src/sigrok_backend.hpp`
(16-byte binary frame header followed by raw logic / float32 analog data).
