#!/bin/sh
set -eu

SOUFLOW_CHECK_NODE="$(command -v node)"
export SOUFLOW_CHECK_NODE
shim_dir="$(mktemp -d)"
trap 'rm -rf "$shim_dir"' EXIT

# 只给调用 Node 测试运行器的命令加 TAP。其他 Node 进程以及自选报告格式的子测试沿用原参数。
cat > "$shim_dir/node" <<'SOUFLOW_NODE'
#!/bin/sh
test_mode=
for arg do
  case "$arg" in
    --test) test_mode=1 ;;
    --test-reporter|--test-reporter=*) exec "$SOUFLOW_CHECK_NODE" "$@" ;;
    --) break ;;
  esac
done
if [ -n "$test_mode" ]; then
  exec "$SOUFLOW_CHECK_NODE" --test-reporter=tap "$@"
fi
exec "$SOUFLOW_CHECK_NODE" "$@"
SOUFLOW_NODE
chmod +x "$shim_dir/node"
PATH="$shim_dir:$PATH" npm run check
