import css from '@eslint/css';
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import pluginReact from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['src/**/*.{ts,tsx}'];
const configFiles = ['*.config.{js,mjs,cjs}', 'webpack.*.js', 'postcss.config.js', 'tailwind.config.js'];

function warnOnLegacyCode(ruleConfig) {
  if (ruleConfig === 'error' || ruleConfig === 2) {
    return 'warn';
  }

  if (Array.isArray(ruleConfig) && (ruleConfig[0] === 'error' || ruleConfig[0] === 2)) {
    return ['warn', ...ruleConfig.slice(1)];
  }

  return ruleConfig;
}

function stageRecommendedRules(configs, files) {
  return configs.map((config) => ({
    ...config,
    files: config.files ?? files,
    ...(config.rules
      ? {
          rules: Object.fromEntries(
            Object.entries(config.rules).map(([ruleName, ruleConfig]) => [ruleName, warnOnLegacyCode(ruleConfig)]),
          ),
        }
      : {}),
  }));
}

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.log',
      '**/*.tsbuildinfo',
      'package-lock.json',
      'src/typings/*.d.ts',
      '.cache/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
      reportUnusedInlineConfigs: 'warn',
    },
  },
  {
    files: [...configFiles, 'scripts/**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        ...globals.es2021,
        ...globals.node,
      },
    },
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off',
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': 'warn',
    },
  },
  {
    files: ['webpack.*.js', 'postcss.config.js', 'scripts/**/*.{js,cjs}'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    files: sourceFiles,
    languageOptions: {
      globals: {
        ...globals.es2021,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  ...stageRecommendedRules(tseslint.configs.recommendedTypeChecked, sourceFiles),
  {
    files: sourceFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    ...pluginReact.configs.flat.recommended,
    files: sourceFiles,
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...pluginReact.configs.flat.recommended.rules,
      'react/react-in-jsx-scope': 'off',
    },
  },
  {
    ...pluginReact.configs.flat['jsx-runtime'],
    files: sourceFiles,
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: sourceFiles,
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    files: ['**/*.css'],
    language: 'css/css',
    ...css.configs.recommended,
    rules: {
      ...css.configs.recommended.rules,
      'css/no-important': 'warn',
    },
  },
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
