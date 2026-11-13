// Bakgrundstjänst för hemskärmen. TizenBrew kör den här filen inne i sin egen tjänst,
// som har tillgång till TV:ns funktioner (tizen-objektet). Hemskärmen pratar med den
// via http://127.0.0.1:8085.
//
// Skriven i gammal JavaScript (ES5) eftersom 2018-TV:ns Node.js är version 4.

var http = require("http");
var fs = require("fs");
var PORT = 8085;

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(obj));
}

function query(url) {
  var out = {}, q = url.split("?")[1] || "";
  q.split("&").forEach(function (part) {
    if (!part) return;
    var kv = part.split("=");
    out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
  });
  return out;
}

// ---- Fjärrkontrollsknappar via TV:ns inbyggda fjärrkontrolls-API (port 8001) ----
// Första gången frågar TV:n om "TV-hem" får styra den. Svara Tillåt.
// TizenBrew delar inte sitt WebSocket-bibliotek, så här är en egen minimal WebSocket-klient.
var net = require("net");
var crypto = require("crypto");

function wsConnect(host, port, path, handlers) {
  var key = crypto.randomBytes(16).toString("base64");
  var buf = new Buffer(0), open = false;
  var sock = net.connect(port, host, function () {
    sock.write("GET " + path + " HTTP/1.1\r\nHost: " + host + ":" + port +
      "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
      "\r\nSec-WebSocket-Version: 13\r\n\r\n");
  });

  function frame(opcode, payload) {
    var len = payload.length, head;
    if (len < 126) { head = new Buffer(2); head[1] = 0x80 | len; }
    else { head = new Buffer(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    head[0] = 0x80 | opcode;
    var mask = crypto.randomBytes(4), body = new Buffer(len);
    for (var i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([head, mask, body]);
  }

  var api = {
    send: function (text) { sock.write(frame(1, new Buffer(text, "utf8"))); },
    close: function () { sock.destroy(); }
  };

  sock.on("data", function (d) {
    buf = Buffer.concat([buf, d]);
    if (!open) {
      var idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      var status = buf.slice(0, idx).toString().split("\r\n")[0];
      if (status.indexOf(" 101") < 0) { sock.destroy(); handlers.error("handskakning: " + status); return; }
      open = true; buf = buf.slice(idx + 4);
      handlers.open && handlers.open();
    }
    while (buf.length >= 2) {
      var len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf[1] & 0x80) off += 4;
      if (buf.length < off + len) return;
      var opcode = buf[0] & 0x0f, payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (opcode === 1) handlers.message(payload.toString("utf8"));
      else if (opcode === 9) sock.write(frame(10, payload));
      else if (opcode === 8) sock.destroy();
    }
  });
  sock.on("error", function (e) { handlers.error(String(e)); });
  sock.on("close", function () { handlers.close && handlers.close(); });
  return api;
}

var remote = null, remoteReady = false, keyQueue = [], lastRemoteError = "", lastRemoteMsg = "";

function openRemote() {
  var name = new Buffer("TV-hem").toString("base64");
  remote = wsConnect("127.0.0.1", 8001, "/api/v2/channels/samsung.remote.control?name=" + name, {
    message: function (msg) {
      try {
        var data = JSON.parse(msg);
        lastRemoteMsg = data.event || "";
        if (data.event === "ms.channel.connect") {
          remoteReady = true;
          while (keyQueue.length) sendKeyNow(keyQueue.shift());
        } else if (data.event === "ms.channel.unauthorized") {
          lastRemoteError = "TV:n nekade – välj Tillåt när den frågar";
        }
      } catch (e) {}
    },
    error: function (e) { lastRemoteError = e; remote = null; remoteReady = false; },
    close: function () { remote = null; remoteReady = false; }
  });
}

function sendKeyNow(key) {
  remote.send(JSON.stringify({
    method: "ms.remote.control",
    params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" }
  }));
}

function sendKey(key) {
  if (remote && remoteReady) return sendKeyNow(key);
  keyQueue = [key];
  if (!remote) openRemote();
}

// ---- Ingångar via tvwindow ----
function getVideoSources(cb) {
  try {
    tizen.systeminfo.getPropertyValue("VIDEOSOURCE",
      function (v) { cb(null, v); },
      function (e) { cb(e.message || String(e)); });
  } catch (e) { cb(String(e)); }
}

function switchWithTvwindow(n, cb) {
  if (!tizen || !tizen.tvwindow) return cb("tvwindow finns inte här");
  getVideoSources(function (err, v) {
    if (err) return cb("VIDEOSOURCE: " + err);
    // Tizen 4 listar en avstängd pryl som "disconnected", så vi letar i båda listorna
    var all = (v.connected || []).concat(v.disconnected || []), src = null;
    for (var i = 0; i < all.length; i++) if (all[i].type === "HDMI" && all[i].number === n) src = all[i];
    if (!src) return cb("hittade inte HDMI " + n);
    try {
      tizen.tvwindow.setSource(src, function () {
        try {
          tizen.application.launch("org.tizen.tv-viewer", function () { cb(null); }, function (e) { cb("tv-viewer: " + e.message); });
        } catch (e) { cb("tv-viewer: " + e); }
      }, function (e) { cb("setSource: " + (e.message || e)); });
    } catch (e) { cb("setSource: " + e); }
  });
}

// ---- Webbserver ----
var server = http.createServer(function (req, res) {
  var path = req.url.split("?")[0];
  var q = query(req.url);

  // Lista alla installerade appar
  if (path === "/apps") {
    try {
      tizen.application.getAppsInfo(function (list) {
        send(res, 200, list.map(function (a) {
          return { id: a.id, name: a.name, icon: a.iconPath || "", show: a.show, cat: a.categories || [] };
        }));
      }, function (err) { send(res, 500, { error: err.message }); });
    } catch (e) { send(res, 500, { error: String(e) }); }
    return;
  }

  // Starta en app
  if (path === "/launch") {
    try {
      tizen.application.launch(q.id,
        function () { send(res, 200, { ok: true }); },
        function (err) { send(res, 500, { error: err.message }); });
    } catch (e) { send(res, 500, { error: String(e) }); }
    return;
  }

  // Byt HDMI-ingång.
  // Sätt 1 (som andra hemskärmsprojekt): tvwindow.setSource + öppna Samsungs TV-visare.
  // Sätt 2 (reserv): tryck på knappen KEY_HDMIx via fjärrkontrolls-API:t.
  if (path === "/hdmi") {
    var n = parseInt(q.n, 10);
    switchWithTvwindow(n, function (tvErr) {
      if (!tvErr) return send(res, 200, { ok: true, method: "tvwindow" });
      try {
        lastRemoteError = "";
        sendKey("KEY_HDMI" + n);
        setTimeout(function () {
          if (lastRemoteError) send(res, 500, { error: lastRemoteError, tvwindow: tvErr });
          else send(res, 200, { ok: true, method: "knapp", tvwindow: tvErr });
        }, 1500);
      } catch (e) { send(res, 500, { error: String(e), tvwindow: tvErr }); }
    });
    return;
  }

  // Skicka valfri fjärrkontrollsknapp (för test), t.ex. /key?k=KEY_SOURCE
  if (path === "/key") {
    sendKey(q.k);
    setTimeout(function () { send(res, 200, { ready: remoteReady, error: lastRemoteError, msg: lastRemoteMsg }); }, 1500);
    return;
  }

  // Felsökning: vad TV:n säger om ingångar, visare och fjärr-anslutningen
  if (path === "/diag") {
    var out = {
      tvwindow: !!(tizen && tizen.tvwindow),
      remoteReady: remoteReady, remoteError: lastRemoteError, remoteMsg: lastRemoteMsg
    };
    getVideoSources(function (err, v) {
      out.videoSource = err ? ("fel: " + err) : v;
      try {
        tizen.application.getAppsInfo(function (list) {
          out.viewerApps = list.filter(function (a) {
            return /viewer|source|hdmi|tv-?player|livetv/i.test(a.id + " " + a.name);
          }).map(function (a) { return a.id + " (" + a.name + ")"; });
          send(res, 200, out);
        }, function () { send(res, 200, out); });
      } catch (e) { send(res, 200, out); }
    });
    return;
  }

  // Skicka en appikon (bildfil som ligger på TV:n)
  if (path === "/icon") {
    var file = (q.p || "").replace(/^file:\/\//, "");
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
      res.writeHead(200, {
        "Content-Type": /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "max-age=86400"
      });
      res.end(data);
    });
    return;
  }

  if (path === "/ping") return send(res, 200, { ok: true });
  send(res, 404, { error: "okänd adress" });
});

server.on("error", function (e) {
  // Om tjänsten redan kör (t.ex. efter omstart av modulen) gör det inget.
  if (e.code !== "EADDRINUSE") console.log("tv-hem service error: " + e);
});
server.listen(PORT, "127.0.0.1");
