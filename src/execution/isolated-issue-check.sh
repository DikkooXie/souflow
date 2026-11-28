#!/bin/sh
set -eu

shim_dir="$(mktemp -d)"
trap 'rm -rf "$shim_dir"' EXIT
# 固定真实 Node。被测仓库可能再次启动旧版检查脚本并改写自己的环境变量。
ln -s "$(node -p 'process.execPath')" "$shim_dir/node-bin"

# 只给调用 Node 测试运行器的命令加 TAP。其他 Node 进程以及自选报告格式的子测试沿用原参数。
cat > "$shim_dir/node" <<'SOUFLOW_NODE'
#!/bin/sh
node_bin="${0%/*}/node-bin"
test_mode=
for arg do
  case "$arg" in
    --test) test_mode=1 ;;
    --test-reporter|--test-reporter=*) exec "$node_bin" "$@" ;;
    --) break ;;
  esac
done
if [ -n "$test_mode" ]; then
  exec "$node_bin" --test-reporter=tap "$@"
fi
exec "$node_bin" "$@"
SOUFLOW_NODE
chmod +x "$shim_dir/node"
PATH="$shim_dir:$PATH" npm run check
