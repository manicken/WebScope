//! A connection to a board, for the LogicAnalyzer and sigrok-pico drivers: a USB serial port ("COM5",
//! "/dev/ttyACM0") or, for the LogicAnalyzer's WiFi boards, TCP ("192.168.1.20:4045").
//! Reads poll with a short timeout, so a capture loop can also watch its stop flag and its deadlines.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(20);

enum Io {
    Serial(Box<dyn serialport::SerialPort>),
    Tcp(TcpStream),
}

pub struct Link {
    io: Io,
}

/// "192.168.1.20:4045" is a network board, anything else a serial port.
pub fn is_network(conn: &str) -> bool {
    conn.rsplit_once(':').is_some_and(|(host, port)| !host.is_empty() && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

impl Link {
    pub fn open(conn: &str, connect_timeout: Duration) -> Result<Link, String> {
        if is_network(conn) {
            let addr = conn.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or(format!("no connection to {conn}"))?;
            let sock = TcpStream::connect_timeout(&addr, connect_timeout).map_err(|e| {
                if e.kind() == ErrorKind::TimedOut { format!("no connection to {conn}") } else { e.to_string() }
            })?;
            let _ = sock.set_nodelay(true);
            sock.set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;
            return Ok(Link { io: Io::Tcp(sock) });
        }
        let mut port = serialport::new(conn, 115_200).timeout(POLL).open().map_err(|e| e.to_string())?;
        // the boards only send while the host has DTR set (tud_cdc_connected)
        let _ = port.write_data_terminal_ready(true);
        let _ = port.write_request_to_send(true);
        Ok(Link { io: Io::Serial(port) })
    }

    pub fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        let w: &mut dyn Write = match &mut self.io {
            Io::Serial(p) => p.as_mut(),
            Io::Tcp(s) => s,
        };
        w.write_all(bytes).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }

    /// What arrived within the poll time: Ok(0) when nothing did, Err when the connection is gone.
    pub fn recv(&mut self, buf: &mut [u8]) -> Result<usize, String> {
        let r = match &mut self.io {
            Io::Serial(p) => match p.read(buf) {
                Ok(n) => Ok(n),
                Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => Ok(0),
                Err(e) => Err(e.to_string()),
            },
            Io::Tcp(s) => match s.read(buf) {
                Ok(0) => Err("closed".to_string()),
                Ok(n) => Ok(n),
                Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => Ok(0),
                Err(e) => Err(e.to_string()),
            },
        };
        r.map_err(|_| "the connection to the board was lost".to_string())
    }

    /// Throws away what the board sent so far (Node's link drops data while nobody listens).
    pub fn discard(&mut self) {
        match &mut self.io {
            Io::Serial(p) => {
                let _ = p.clear(serialport::ClearBuffer::Input);
            }
            Io::Tcp(s) => {
                let mut buf = [0u8; 4096];
                let _ = s.set_nonblocking(true);
                while matches!(s.read(&mut buf), Ok(n) if n > 0) {}
                let _ = s.set_nonblocking(false);
            }
        }
    }

    /// Reads until `done(text received so far)` gives a result, or `timeout` passes.
    pub fn read_until<T>(&mut self, timeout: Duration, mut done: impl FnMut(&[u8]) -> Option<T>) -> Result<Option<T>, String> {
        let deadline = Instant::now() + timeout;
        let mut got = Vec::new();
        let mut buf = [0u8; 4096];
        while Instant::now() < deadline {
            let n = self.recv(&mut buf)?;
            if n > 0 {
                got.extend_from_slice(&buf[..n]);
                if let Some(r) = done(&got) {
                    return Ok(Some(r));
                }
            }
        }
        Ok(None)
    }
}

/// The USB serial ports of devices with this vendor / product id.
pub fn usb_ports(vid: u16, pid: u16) -> Vec<String> {
    match serialport::available_ports() {
        Ok(ports) => ports
            .into_iter()
            .filter(|p| matches!(&p.port_type, serialport::SerialPortType::UsbPort(u) if u.vid == vid && u.pid == pid))
            .map(|p| p.port_name)
            .collect(),
        Err(e) => {
            eprintln!("serial port list failed: {e}");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn network_or_serial() {
        assert!(super::is_network("192.168.1.20:4045"));
        assert!(super::is_network("scope.lan:4045"));
        assert!(!super::is_network("COM5"));
        assert!(!super::is_network("/dev/ttyACM0"));
    }
}
