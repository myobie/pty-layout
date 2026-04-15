import { defineConfig } from "vitest/config";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const testSessionDir = path.join(os.tmpdir(), `pty-layout-test-${process.pid}`);
fs.mkdirSync(testSessionDir, { recursive: true });

export default defineConfig({
  test: {
    exclude: [
      "node_modules/**",
    ],
    env: {
      PTY_SESSION_DIR: testSessionDir,
    },
  },
});
