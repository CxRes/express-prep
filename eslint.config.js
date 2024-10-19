/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import js from "@eslint/js";
import { includeIgnoreFile } from "@eslint/compat";
import globals from "globals";
import prettier from "eslint-config-prettier";
import vitest from "@vitest/eslint-plugin";
import noOnlyTests from "eslint-plugin-no-only-tests";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: ["docs/**"],
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  prettier,
  {
    files: ["**/*.test.js"],
    plugins: {
      vitest,
      noOnlyTests,
    },
    rules: {
      ...vitest.configs.recommended.rules,
      "noOnlyTests/no-only-tests": ["error", { fix: true }],
    },
  },
];
