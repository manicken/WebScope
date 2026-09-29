# WebScope

A browser-based logic analyzer GUI.

WebScope runs directly in a web browser and is designed to communicate with a backend that bridges the browser to a physical logic analyzer. The backend can run locally on the same computer and communicate with hardware over USB, or potentially run remotely on a Raspberry Pi or even a small MCU.

## Why?

The idea came from looking at existing logic analyzer software and especially [Edgewise](https://github.com/mtharrison/edgewise).

Edgewise is a modern logic analyzer project with a Rust backend and a graphical frontend. It showed that a relatively lightweight logic analyzer could provide a much more modern workflow than traditional tools.

I wanted to take that idea in a different direction:

* Run the GUI directly in a web browser.
* Keep the hardware interface separate from the GUI.
* Allow the capture backend to run on another computer or embedded device.
* Keep protocol decoding in the frontend.
* Make decoders easy to extend and chain together.
* Make decoded data available for export and further processing.
* Support importing captures directly instead of being tied to a particular hardware backend.
* Maybe most importantly, I want a non-bloated solution with far fewer dependencies.


This also makes it possible to use the same frontend with very different backends. A backend could be a native USB driver on a PC, a Raspberry Pi connected to a logic analyzer, or eventually a small MCU acting as a capture gateway.

## Based on Edgewise

WebScope is directly based on code from [mtharrison/edgewise](https://github.com/mtharrison/edgewise).

The initial implementation started as a port and adaptation of the Edgewise code, particularly its waveform/capture concepts and demo source. From there, the architecture is being changed toward a browser-based frontend with a separate capture backend.

This project should therefore be considered a derivative work rather than an unrelated implementation of the same idea.

Please see the original Edgewise repository and its license for the original project's licensing and attribution information.

## Architecture

The intended architecture is roughly:

```text
                    Web Browser
                 ┌───────────────┐
                 │    WebScope   │
                 │               │
                 │ Waveform UI   │
                 │ Decoders      │
                 │ Data export   │
                 └───────┬───────┘
                         │
                    HTTP / WebSocket
                         │
                 ┌───────▼───────┐
                 │    Backend    │
                 │               │
                 │ Capture       │
                 │ Buffering     │
                 │ Hardware I/O  │
                 └───────┬───────┘
                         │
                    USB / SPI / ...
                         │
                 ┌───────▼───────┐
                 │ Logic Analyzer│
                 └───────────────┘
```

The backend is intended to capture data as quickly as possible and buffer it independently of the frontend. The browser can then consume and render the captured data at its own pace.

## Decoder architecture

Protocol decoding is intended to be layered.

For example:

```text
Raw samples
    │
    ▼
   I²C
    │
    ▼
 EEPROM
    │
    ▼
 Application protocol
```

A decoder can consume the output of another decoder, allowing arbitrary decoder chains without requiring every possible protocol to be built into the core.

The decoded result can contain both presentation annotations and structured data. This allows decoded information to be displayed, passed to another decoder, or exported independently.

## Current status

This project is currently under development.

The browser frontend, capture buffer, demo source and initial UART/I²C/SPI decoding are being developed first. Hardware backends and the final browser-to-backend protocol will be added separately.

Expect things to change.

## License

See the original [Edgewise repository](https://github.com/mtharrison/edgewise) and the license included with this project for licensing information.
