# blind-test — `make` installs deps (if needed), starts the app and opens it in
# your browser at http://localhost:5199

.DEFAULT_GOAL := dev
.PHONY: dev install build preview clean reset-stats help

## dev: install deps if needed, start the dev server and open the browser
dev: node_modules
	npm run dev

## install: install npm dependencies
install: node_modules

# Reinstall whenever package.json / lockfile is newer than node_modules.
node_modules: package.json
	npm install
	@touch node_modules

## build: type-check and build to dist/
build: node_modules
	npm run build

## preview: serve the production build (no backend — dev server only)
preview: build
	npm run preview

## clean: remove build output and TS build info
clean:
	rm -rf dist tsconfig.tsbuildinfo tsconfig.node.tsbuildinfo vite.config.js vite.config.d.ts

## reset-stats: delete all recorded rounds and raw logs (groups are kept)
reset-stats:
	rm -rf data/rounds data/logs
	@echo "rounds and logs cleared"

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
