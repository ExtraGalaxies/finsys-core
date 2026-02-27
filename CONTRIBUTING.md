# Contributing to @finsys/core

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/TODO/finsys-core.git
cd finsys-core

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type-check without emitting
npm run lint
```

## Making Changes

1. Fork the repository and create a branch from `main`
2. Make your changes
3. Add or update tests for any new functionality
4. Ensure all tests pass: `npm test`
5. Ensure the build succeeds: `npm run build`
6. Ensure type-checking passes: `npm run lint`
7. Submit a pull request

## Code Style

- TypeScript with strict mode enabled
- Follow existing patterns in the codebase
- Keep functions focused and well-typed
- Add JSDoc comments for exported functions

## Reporting Issues

- Use GitHub Issues to report bugs or request features
- Include a minimal reproduction case when reporting bugs
- Include the version of `@finsys/core` you're using

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.
