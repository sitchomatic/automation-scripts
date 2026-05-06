const fs = require("fs");
const r = JSON.parse(fs.readFileSync("fingerprint-results.json", "utf-8"));
for (const s of r) {
  const b = s.rawJsonHits[0] && s.rawJsonHits[0].body;
  if (!b) {
    console.log("[" + s.sessionIdx + "] no body captured");
    continue;
  }
  const a = b.raw_device_attributes || {};
  console.log("\n=== Session " + s.sessionIdx + " (visitor_id: " + (b.identification && b.identification.visitor_id) + ") ===");
  console.log("bot:", b.bot, "/", b.bot_type);
  console.log("suspect_score:", b.suspect_score);
  console.log("tampering:", b.tampering, "ml_score:", b.tampering_ml_score, "anti_detect:", b.tampering_details && b.tampering_details.anti_detect_browser);
  console.log("vm:", b.virtual_machine, "vm_score:", b.virtual_machine_ml_score);
  console.log("hw_concurrency:", a.hardware_concurrency);
  console.log("device_memory:", a.device_memory);
  console.log("webgl_vendor:", a.webgl_basics && a.webgl_basics.vendor_unmasked);
  console.log("webgl_renderer:", a.webgl_basics && a.webgl_basics.renderer_unmasked);
  console.log("canvas_geom:", a.canvas && a.canvas.geometry);
  console.log("canvas_text:", a.canvas && a.canvas.text);
  console.log("audio:", a.audio);
  console.log("fonts:", (a.fonts || []).length, "entries");
  console.log("platform:", a.platform);
  console.log("architecture:", a.architecture);
  console.log("locale:", a.date_time_locale);
  console.log("os_mismatch:", b.vpn_methods && b.vpn_methods.os_mismatch);
}

