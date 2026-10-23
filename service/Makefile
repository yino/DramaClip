SHELL := /bin/bash
.DEFAULT_GOAL := help

# Python media service (dramaclip). Managed with uv; heavy ML extras live in [ml].
# 运行时由 Electron 主进程自动拉起（打包为 app-resources/dramaclip-service sidecar）；
# 这个 Makefile 只服务本地开发与 CI，不是客户端启动的必要条件。

UV ?= uv
PYTHON ?= $(UV) run python

.PHONY: help setup test test-file lint lint-fix format format-check typecheck check run clean

help: ## 显示可用目标
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## 安装全部依赖（含 ml 与 dev extras）
	$(UV) sync --all-extras

test: ## 运行 pytest 全量测试
	$(PYTHON) -m pytest

test-file: ## 只跑一个测试文件或目录：make test-file FILE=tests/infra/ffmpeg
	@test -n "$(FILE)" || { echo "用法: make test-file FILE=<path>"; exit 2; }
	$(PYTHON) -m pytest $(FILE)

lint: ## ruff 静态检查
	$(PYTHON) -m ruff check .

lint-fix: ## ruff 自动修复
	$(PYTHON) -m ruff check . --fix

format: ## ruff 格式化
	$(PYTHON) -m ruff format .

format-check: ## 格式化检查（不写盘）
	$(PYTHON) -m ruff format --check .

typecheck: ## mypy 类型检查（dramaclip 包）
	$(PYTHON) -m mypy dramaclip

check: lint format-check typecheck test ## 提交前门禁

run: ## 以开发 token 独立启动服务（需已有监听方，正常由 Electron 拉起）
	DRAMACLIP_SERVICE_ADDRESS=$${DRAMACLIP_SERVICE_ADDRESS:-127.0.0.1:51801} \
	DRAMACLIP_AUTH_TOKEN=$${DRAMACLIP_AUTH_TOKEN:-dev} \
	$(PYTHON) -m dramaclip

clean: ## 清理缓存（保留 .venv）
	find . -path ./.venv -prune -o -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -rf .pytest_cache .ruff_cache .mypy_cache
