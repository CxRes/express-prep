/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import { configDefaults, defineConfig } from "vitest/config";
import parseGitignore from "parse-gitignore";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const gitignorePath = resolve(__dirname, ".gitignore");
const gitignoreFile = readFileSync(gitignorePath, "utf-8");
const gitignore = parseGitignore(gitignoreFile);
const gitignorePatterns = gitignore.patterns.map((pattern) => `**/${pattern}`);

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...gitignorePatterns],
    coverage: {
      include: ["src/", "test/**"],
      exclude: [...configDefaults.coverage.exclude, ...gitignorePatterns],
    },
  },
});
