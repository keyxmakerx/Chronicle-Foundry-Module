/**
 * What is in vendor/chronicle/: each copy's engine, its path in Chronicle and
 * the first 12 hex characters of its sha256. Written by
 * tools/refresh-vendor.mjs, never by hand; tools/test-vendor-manifest.mjs
 * checks it against the files.
 */
export const VENDOR_MANIFEST = Object.freeze({
  "cutscene_engine.js": { engine: "cutscenes", source: "static/js/cutscene_engine.js", digest: "69533c967f80" },
  "gl_shared.js": { engine: "sky", source: "static/js/widgets/gl_shared.js", digest: "58a97f609643" },
  "shop_room.js": { engine: "shop", source: "static/js/widgets/shop_room.js", digest: "3d40b9a9065f" },
  "shop_room_counter.js": { engine: "shop", source: "static/js/widgets/shop_room_counter.js", digest: "e958e022d71a" },
  "shop_room_icons.js": { engine: "shop", source: "static/js/widgets/shop_room_icons.js", digest: "c20c1dbc2311" },
  "shop_room_keeper.js": { engine: "shop", source: "static/js/widgets/shop_room_keeper.js", digest: "88519f50100b" },
  "shop_room_paper.js": { engine: "shop", source: "static/js/widgets/shop_room_paper.js", digest: "58550cb3b961" },
  "shop_room_parts_places.js": { engine: "shop", source: "static/js/widgets/shop_room_parts_places.js", digest: "c5149e3891e6" },
  "shop_room_parts_strange.js": { engine: "shop", source: "static/js/widgets/shop_room_parts_strange.js", digest: "e7e1dda536ae" },
  "shop_room_parts_trades.js": { engine: "shop", source: "static/js/widgets/shop_room_parts_trades.js", digest: "118bc019657c" },
  "sky_2d.js": { engine: "sky", source: "static/js/widgets/sky_2d.js", digest: "e30f8b7e86e4" },
  "sky_events.js": { engine: "sky", source: "static/js/widgets/sky_events.js", digest: "5d729336f046" },
  "sky_gl.js": { engine: "sky", source: "static/js/widgets/sky_gl.js", digest: "0f2322e880a5" },
  "sky_looks.js": { engine: "sky", source: "static/js/widgets/sky_looks.js", digest: "eef7ec91a10b" },
  "sky_moon.js": { engine: "sky", source: "static/js/widgets/sky_moon.js", digest: "2a530ca4278a" },
  "sky_pane.js": { engine: "sky", source: "static/js/widgets/sky_pane.js", digest: "e36fb751ab70" },
  "sky_shaders.js": { engine: "sky", source: "static/js/widgets/sky_shaders.js", digest: "81ce6bdff71f" },
  "sky_world.js": { engine: "sky", source: "static/js/widgets/sky_world.js", digest: "ebf8cd9d5570" },
  "crafting_lib.js": { engine: "crafting", source: "internal/plugins/crafting/static/js/crafting_lib.js", digest: "7c89a0bb6e26" },
  "crafting_tray.js": { engine: "crafting", source: "internal/plugins/crafting/static/js/crafting_tray.js", digest: "f54f053a1260" },
  "crafting_block.js": { engine: "crafting", source: "internal/plugins/crafting/static/js/crafting_block.js", digest: "a8cbf348587f" },
  "crafting.css": { engine: "crafting", source: "internal/plugins/crafting/static/css/crafting.css", digest: "5923751e2ffd" },
  "spoils.css": { engine: "crafting", source: "internal/plugins/crafting/static/css/spoils.css", digest: "eed01b5e6662" },
});
