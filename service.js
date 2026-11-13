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
var remote = null, remoteReady = false, keyQueue = [];

function openRemote() {
  var WebSocket = require(process.version === "v4.4.3" ? "ws-old" : "ws-new");
  var name = new Buffer("TV-hem").toString("base64");
  remote = new WebSocket("ws://127.0.0.1:8001/api/v2/channels/samsung.remote.control?name=" + name);
  remote.on("message", function (msg) {
    try {
      var data = JSON.parse(msg);
      if (data.event === "ms.channel.connect") {
        remoteReady = true;
        while (keyQueue.length) sendKeyNow(keyQueue.shift());
      }
    } catch (e) {}
  });
  remote.on("close", function () { remote = null; remoteReady = false; });
  remote.on("error", function () { remote = null; remoteReady = false; });
}

function sendKeyNow(key) {
  remote.send(JSON.stringify({
    method: "ms.remote.control",
    params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" }
  }));
}

function sendKey(key) {
  if (remote && remoteReady) return sendKeyNow(key);
  keyQueue.push(key);
  if (!remote) openRemote();
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
          return { id: a.id, name: a.name, icon: a.iconPath || "" };
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

  // Byt HDMI-ingång (skickar knappen HDMI1, HDMI2 ... som fjärrkontrollen)
  if (path === "/hdmi") {
    try { sendKey("KEY_HDMI" + q.n); send(res, 200, { ok: true }); }
    catch (e) { send(res, 500, { error: String(e) }); }
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
