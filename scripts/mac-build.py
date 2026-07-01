#!/usr/bin/env python3
# 在 Mac mini (arm64) 上构建饭仔客户端：
#   1. 上传源码 tarball
#   2. 下载便携 Node 24 arm64（直连 nodejs.org，已验证 200）
#   3. 解压源码 + npm install + electron-builder（mac dmg/zip arm64）
#   4. 回传产物到本地
#
# 全程用密码认证（paramiko），实时透传远端 stdout/stderr。
import sys
import os
import paramiko

HOST = "192.168.3.9"
USER = "jinpeng"
PASSWORD = "2684"

REMOTE_DIR = "/tmp/fanzai-build"
LOCAL_TGZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fanzai-client-src.tgz")
NODE_VER = "v24.9.0"
NODE_PKG = f"node-{NODE_VER}-darwin-arm64"
NODE_URL = f"https://nodejs.org/dist/{NODE_VER}/{NODE_PKG}.tar.gz"
# 本地取回目录
LOCAL_OUT = "w:/github仓库同步目录/饭仔启动包/runtime/electron-app-mac"


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=20,
              look_for_keys=False, allow_agent=False)
    return c


def run_stream(client, cmd, timeout=1800):
    """执行命令并实时打印输出，返回退出码。"""
    print(f"\n$ {cmd}\n" + "-" * 60)
    chan = client.get_transport().open_session()
    chan.settimeout(timeout)
    chan.get_pty()  # 让远端把 stderr 也归一
    chan.exec_command(cmd)
    buf = b""
    while True:
        if chan.recv_ready():
            data = chan.recv(4096)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                print(line.decode("utf-8", "replace"))
        if chan.exit_status_ready() and not chan.recv_ready():
            break
    if buf:
        print(buf.decode("utf-8", "replace"))
    return chan.recv_exit_status()


def sftp_put(client, local, remote):
    print(f"\n[upload] {local} -> {remote}")
    sftp = client.open_sftp()
    sftp.put(local, remote)
    sftp.close()
    print("[upload] done")


def sftp_get_dir(client, remote_dir, local_dir):
    """把 remote_dir 下的文件（非递归子目录，仅取产物文件）拉回本地。"""
    os.makedirs(local_dir, exist_ok=True)
    sftp = client.open_sftp()
    got = []
    for entry in sftp.listdir_attr(remote_dir):
        name = entry.filename
        # 只取构建产物：dmg / zip / blockmap / yml
        if name.endswith((".dmg", ".zip", ".blockmap", ".yml")):
            rp = f"{remote_dir}/{name}"
            lp = os.path.join(local_dir, name)
            print(f"[download] {rp} -> {lp}  ({entry.st_size} bytes)")
            sftp.get(rp, lp)
            got.append(lp)
    sftp.close()
    return got


def main():
    client = connect()
    print("=== 已连接 Mac mini ===")

    # 1. 准备目录 + 上传源码
    run_stream(client, f"rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR}")
    sftp_put(client, LOCAL_TGZ, f"{REMOTE_DIR}/src.tgz")

    # 2. 下载 + 解压便携 Node（若已存在则复用）
    node_setup = f"""
cd {REMOTE_DIR}
if [ ! -x "{REMOTE_DIR}/{NODE_PKG}/bin/node" ]; then
  echo '下载便携 Node {NODE_VER} (arm64)…'
  curl -fsSL -o node.tar.gz '{NODE_URL}'
  tar -xzf node.tar.gz
  rm -f node.tar.gz
fi
"{REMOTE_DIR}/{NODE_PKG}/bin/node" -v
"""
    code = run_stream(client, node_setup)
    if code != 0:
        print(f"!! Node 准备失败 exit={code}", file=sys.stderr)
        client.close()
        sys.exit(1)

    # 3. 解压源码 + npm install + 构建
    node_bin = f"{REMOTE_DIR}/{NODE_PKG}/bin"
    build = f"""
export PATH="{node_bin}:$PATH"
cd {REMOTE_DIR}
tar -xzf src.tgz
echo '=== npm install ==='
npm install --no-audit --no-fund 2>&1
echo '=== electron-builder (mac arm64) ==='
npx electron-builder --mac --arm64 2>&1
echo '=== 构建产物 ==='
ls -lh {REMOTE_DIR}/../electron-app 2>/dev/null || ls -lh ../electron-app 2>/dev/null
ls -lh dist 2>/dev/null
"""
    code = run_stream(client, build, timeout=2400)
    print(f"\n=== 构建退出码: {code} ===")

    # 4. 找产物目录并回传（只搜构建目录）
    _, out, _ = _run_cap(client, f"find {REMOTE_DIR}/runtime/electron-app -maxdepth 1 \\( -name '*.dmg' -o -name '*.zip' \\) 2>/dev/null")
    print("\n找到的产物文件:")
    print(out or "(无)")

    if out.strip():
        # 逐个下载
        os.makedirs(LOCAL_OUT, exist_ok=True)
        sftp = client.open_sftp()
        for rp in out.strip().splitlines():
            rp = rp.strip()
            if not rp:
                continue
            lp = os.path.join(LOCAL_OUT, os.path.basename(rp))
            try:
                st = sftp.stat(rp)
                print(f"[download] {rp} -> {lp} ({st.st_size} bytes)")
                sftp.get(rp, lp)
            except Exception as e:
                print(f"[download] 跳过 {rp}: {e}")
        sftp.close()

    client.close()
    print("\n=== 完成 ===")


def _run_cap(client, cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR:", type(e).__name__, e, file=sys.stderr)
        sys.exit(1)
