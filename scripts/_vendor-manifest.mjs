/**
 * What is in vendor/chronicle/: each copy's engine, its path in Chronicle and
 * the first 12 hex characters of its sha256. Written by
 * tools/refresh-vendor.mjs, never by hand; tools/test-vendor-manifest.mjs
 * checks it against the files.
 */
export const VENDOR_MANIFEST = Object.freeze({
  "cutscene_engine.js": { engine: "cutscenes", source: "static/js/cutscene_engine.js", digest: "772a5866247d" },
  "gl_shared.js": { engine: "sky", source: "static/js/widgets/gl_shared.js", digest: "58a97f609643" },
  "shop_room.js": { engine: "shop", source: "static/js/widgets/shop_room.js", digest: "2c7ceb7cd2e6" },
  "shop_room_counter.js": { engine: "shop", source: "static/js/widgets/shop_room_counter.js", digest: "4078e91d6455" },
  "shop_room_icons.js": { engine: "shop", source: "static/js/widgets/shop_room_icons.js", digest: "c20c1dbc2311" },
  "shop_room_keeper.js": { engine: "shop", source: "static/js/widgets/shop_room_keeper.js", digest: "88519f50100b" },
  "shop_room_paper.js": { engine: "shop", source: "static/js/widgets/shop_room_paper.js", digest: "58550cb3b961" },
  "shop_room_parts_places.js": { engine: "shop", source: "static/js/widgets/shop_room_parts_places.js", digest: "b6f7f2e14c95" },
  "shop_room_parts_strange.js": { engine: "shop", source: "static/js/widgets/shop_room_parts_strange.js", digest: "e7e1dda536ae" },
  "shop_room_parts_trades.js": { engine: "shop", source: "static/js/widgets/shop_room_parts_trades.js", digest: "118bc019657c" },
  "sky_2d.js": { engine: "sky", source: "static/js/widgets/sky_2d.js", digest: "558f714daeba" },
  "sky_events.js": { engine: "sky", source: "static/js/widgets/sky_events.js", digest: "494946e9464a" },
  "sky_gl.js": { engine: "sky", source: "static/js/widgets/sky_gl.js", digest: "81d6f13ed18d" },
  "sky_looks.js": { engine: "sky", source: "static/js/widgets/sky_looks.js", digest: "34a4f4e2979e" },
  "sky_moon.js": { engine: "sky", source: "static/js/widgets/sky_moon.js", digest: "2a530ca4278a" },
  "sky_pane.js": { engine: "sky", source: "static/js/widgets/sky_pane.js", digest: "e3ab11ccd3e8" },
  "sky_shaders.js": { engine: "sky", source: "static/js/widgets/sky_shaders.js", digest: "2e89e8d30253" },
  "sky_world.js": { engine: "sky", source: "static/js/widgets/sky_world.js", digest: "07a69640716b" },
  "crafting_lib.js": { engine: "crafting", source: "internal/plugins/crafting/static/js/crafting_lib.js", digest: "7c89a0bb6e26" },
  "crafting_tray.js": { engine: "crafting", source: "internal/plugins/crafting/static/js/crafting_tray.js", digest: "f54f053a1260" },
  "crafting_block.js": { engine: "crafting", source: "internal/plugins/crafting/static/js/crafting_block.js", digest: "a8cbf348587f" },
  "crafting.css": { engine: "crafting", source: "internal/plugins/crafting/static/css/crafting.css", digest: "5923751e2ffd" },
  "spoils.css": { engine: "crafting", source: "internal/plugins/crafting/static/css/spoils.css", digest: "eed01b5e6662" },
});
