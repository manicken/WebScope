//! Minimal HTTP/1.1 plumbing (std only): request parsing, responses, the /api/fs virtual
//! filesystem (GET/HEAD/PUT/DELETE under the data dir) and the static file server.
//! Every response is `Connection: close`.

use serde_json::{Map, Value};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub type Reader<'a> = BufReader<&'a TcpStream>;

pub struct Request {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// An HTTP status to answer with.
pub struct HttpError(pub u16);

impl From<io::Error> for HttpError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::NotFound {
            HttpError(404)
        } else {
            eprintln!("HTTP error: {e}");
            HttpError(500)
        }
    }
}

fn bad_request() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "bad request")
}

pub fn read_request(reader: &mut Reader) -> io::Result<Request> {
    let mut line = String::new();
    if reader.by_ref().take(8192).read_line(&mut line)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(bad_request());
    };
    if !version.starts_with("HTTP/1.") {
        return Err(bad_request());
    }
    let (method, target) = (method.to_string(), target.to_string());

    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        let n = reader.by_ref().take(16 * 1024).read_line(&mut h)?;
        if n == 0 || !h.ends_with('\n') || headers.len() > 100 {
            return Err(bad_request());
        }
        let h = h.trim_end_matches(['\r', '\n']);
        if h.is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').ok_or_else(bad_request)?;
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }
    Ok(Request { method, target, headers })
}

fn reason(status: u16) -> &'static str {
    match status {
        101 => "Switching Protocols",
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        _ => "Internal Server Error",
    }
}

pub fn respond(out: &TcpStream, status: u16, content_type: Option<&str>, body: &[u8], head_only: bool) -> io::Result<()> {
    respond_with(out, status, content_type, &[], body, head_only)
}

/// `extra`: more headers, e.g. the CORS ones of /api/fs.
pub fn respond_with(mut out: &TcpStream, status: u16, content_type: Option<&str>, extra: &[(String, String)], body: &[u8], head_only: bool) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    if let Some(ct) = content_type {
        head += &format!("Content-Type: {ct}\r\n");
    }
    for (k, v) in extra {
        head += &format!("{k}: {v}\r\n");
    }
    if status != 204 {
        head += &format!("Content-Length: {}\r\n", body.len());
    }
    head += "Connection: close\r\n\r\n";
    out.write_all(head.as_bytes())?;
    if !head_only && status != 204 {
        out.write_all(body)?;
    }
    out.flush()
}

pub fn respond_error(out: &TcpStream, status: u16) {
    let msg = match status {
        400 => "Invalid file operation",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        _ => "Internal Server Error",
    };
    let _ = respond(out, status, Some("text/plain; charset=utf-8"), msg.as_bytes(), false);
}

/// Close politely: if the client still has unread request body in flight (e.g. a rejected PUT),
/// closing straight away would RST the connection and the client might never see our response.
pub fn finish(stream: &TcpStream) {
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    let mut sink = [0u8; 8192];
    let mut left = 8 * 1024 * 1024usize;
    let mut s = stream;
    while left > 0 {
        match s.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(n) => left = left.saturating_sub(n),
        }
    }
}

pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1..i + 3)?;
            if !h.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "py" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Lexically normalise a request path into a relative path; anything that would leave the
/// root (`..` past the top, absolute paths, drive prefixes) is 403.
fn lexical_rel(virt: &str) -> Result<PathBuf, HttpError> {
    let mut rel = PathBuf::new();
    for c in Path::new(virt).components() {
        match c {
            Component::Normal(s) => rel.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                if !rel.pop() {
                    return Err(HttpError(403));
                }
            }
            Component::RootDir | Component::Prefix(_) => return Err(HttpError(403)),
        }
    }
    Ok(rel)
}

/// `data_dir` must already be canonical. Also follows symlinks to make sure the real
/// location stays inside the data dir.
fn resolve_virtual_path(data_dir: &Path, virt: &str) -> Result<PathBuf, HttpError> {
    let rel = lexical_rel(virt)?;
    let file = data_dir.join(&rel);
    let is_root = rel.as_os_str().is_empty();

    // root directory is allowed
    let check = if is_root { file.clone() } else { file.parent().unwrap_or(data_dir).to_path_buf() };
    if !fs::canonicalize(check)?.starts_with(data_dir) {
        return Err(HttpError(403));
    }

    // if the target exists, verify its real location
    if !is_root {
        match fs::canonicalize(&file) {
            Ok(real) => {
                if !real.starts_with(data_dir) {
                    return Err(HttpError(403));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                // dangling symlink: writing through it could escape the data dir
                if fs::symlink_metadata(&file).is_ok() {
                    return Err(HttpError(403));
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(file)
}

/// The virtual file system under `data_dir` (canonical): GET / HEAD of a file or a folder listing, PUT,
/// DELETE. Also serves the read-only Python folders (the caller only lets GET / HEAD through).
pub fn serve_fs(
    stream: &TcpStream,
    reader: &mut Reader,
    req: &Request,
    data_dir: &Path,
    requested: &str,
    extra: &[(String, String)],
) -> Result<(), HttpError> {
    let path = resolve_virtual_path(data_dir, requested)?;
    let respond = |out: &TcpStream, status: u16, ct: Option<&str>, body: &[u8], head_only: bool| respond_with(out, status, ct, extra, body, head_only);

    match req.method.as_str() {
        "GET" | "HEAD" => {
            let head_only = req.method == "HEAD";
            let meta = fs::metadata(&path)?;

            if meta.is_dir() {
                let mut list = Vec::new();
                for entry in fs::read_dir(&path)? {
                    let entry = entry?;
                    let is_dir = entry.file_type()?.is_dir();
                    let info = fs::metadata(entry.path())?;
                    let mut o = Map::new();
                    o.insert("name".into(), entry.file_name().to_string_lossy().into_owned().into());
                    if is_dir {
                        o.insert("isDir".into(), true.into());
                    } else {
                        o.insert("size".into(), info.len().into());
                    }
                    list.push(Value::Object(o));
                }
                let body = Value::Array(list).to_string();
                respond(stream, 200, Some("application/json"), body.as_bytes(), head_only)?;
                return Ok(());
            }

            let content = fs::read(&path)?;
            respond(stream, 200, Some(mime_type(&path)), &content, head_only)?;
        }
        "PUT" => {
            if req.header("transfer-encoding").is_some() {
                return Err(HttpError(411)); // chunked uploads are not supported
            }
            let len: u64 = req.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
            if path.is_dir() {
                return Err(HttpError(400));
            }
            let mut f = fs::File::create(&path)?;
            io::copy(&mut reader.by_ref().take(len), &mut f)?;
            respond(stream, 204, None, &[], false)?;
        }
        "DELETE" => {
            if path.is_dir() {
                return Err(HttpError(400));
            }
            fs::remove_file(&path)?;
            respond(stream, 204, None, &[], false)?;
        }
        _ => return Err(HttpError(405)),
    }
    Ok(())
}

pub fn serve_static(stream: &TcpStream, req: &Request, public_dir: &Path, pathname: &str) -> Result<(), HttpError> {
    if req.method != "GET" && req.method != "HEAD" {
        return Err(HttpError(405));
    }
    let requested = if pathname == "/" { "index.html" } else { pathname.trim_start_matches('/') };
    let rel = lexical_rel(requested)?;
    if rel.as_os_str().is_empty() {
        return Err(HttpError(403));
    }
    let path = public_dir.join(rel);
    if fs::metadata(&path)?.is_dir() {
        return Err(HttpError(400));
    }
    let content = fs::read(&path)?;
    respond(stream, 200, Some(mime_type(&path)), &content, req.method == "HEAD")?;
    Ok(())
}
