import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // MUI v9's `Typography` resolves `color` through palette-derived VARIANTS named
      // `textPrimary | textSecondary | textDisabled` (Typography.js:69–74). A dotted path matches
      // none of them and is dropped silently — no error, no warning, no `color` in the generated
      // class. 269 call sites across 82 files had been rendering every intentionally-muted label
      // at full ink since the v6 → v9 upgrade, and nothing noticed because tests query by role and
      // name, never by colour (design review of /balance, Must Fix 2).
      //
      // A `sx={{ color: 'text.secondary' }}` object still works and is not restricted here — only
      // the prop form, which is the one that fails.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="color"][value.value=/^(text|primary|secondary|error|warning|success|info)\\./]',
          message:
            "A dotted palette path in the `color` PROP is silently dropped by MUI v9. Use the variant name (color=\"textSecondary\") or sx={{ color: 'text.secondary' }}.",
        },
      ],
    },
  },
  {
    // Tests and their helpers are not Fast Refresh boundaries — the rule that every module in a
    // React tree export only components does not apply to a file whose job is to export a render
    // helper. They also run in Node, so they see both global sets.
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
