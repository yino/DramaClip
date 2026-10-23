SHELL := /bin/bash
.DEFAULT_GOAL := help

# Desktop app (Electron + React). Dependencies are installed from the workspace
# root (code/) because desktop is an npm workspace.

.PHONY: help setup dev build dist test test-watch lint lint-fix typecheck check clean

help: ## 显示可用目标
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## 安装依赖（在 workspace 根执行 npm ci）
	cd .. && npm ci

dev: ## 启动开发模式（Vite + Electron 热更新）
	npm run dev

build: ## 构建渲染层与主进程（dist/ + dist-electron/）
	npm run build

dist: ## 打 Windows 安装包（electron-builder，仅 Windows/CI）
	npm run dist

test: ## 运行 Vitest 全量测试
	npm test

test-watch: ## 监听模式跑测试
	npx vitest

lint: ## ESLint 检查 src 与 main
	npm run lint

lint-fix: ## ESLint 自动修复
	npm run lint -- --fix

typecheck: ## TypeScript 类型检查（app + node 两套配置）
	npm run typecheck

check: lint typecheck test ## 提交前门禁：lint + typecheck + test

clean: ## 清理构建产物
	rm -rf dist dist-electron
