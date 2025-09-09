import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

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
			'@typescript-eslint/no-explicit-any': 'error',
			'no-restricted-syntax': [
				'error',
				{
					selector: 'TSTypeAnnotation > TSUnknownKeyword',
					message: 'unknown is forbidden; use a concrete JsonValue / union.',
				},
				{
					selector: 'TSTypeAnnotation > TSNeverKeyword',
					message:
						'never is forbidden in public signatures; use a concrete union member.',
				},
			],
		},
	},
	{
		ignores: ['dist', 'node_modules'],
	},
	{
		files: ['src/types/json.ts'],
		rules: {
			'@typescript-eslint/consistent-indexed-object-style': 'off',
		},
	},
];
