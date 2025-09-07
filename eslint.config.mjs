// ESLint v9 flat config (ESM)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.stylistic,
	prettier,
	{
		files: ['**/*.ts'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
		},
		rules: {
			'@typescript-eslint/explicit-function-return-type': 'off',
		},
	},
	{
		ignores: ['dist', 'node_modules'],
	},
];
