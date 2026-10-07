// Stable recordings must not be interrupted by source-file watcher restarts.
// CESIUM_SAFETY_DATA_DIR must point to a dedicated test directory.
import config from "../vite.config.ts";

export default { ...config, server: { ...config.server, hmr: false, watch: null } };
