package io.github.lq1123.bilimusic;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.json.JSONObject;

/**
 * #26 局域网发现：约定端口（桌面后端 --lan 绑 0.0.0.0 的那个端口）扫本机所在 /24 网段，
 * 逐 IP 试 /api/discovery/ping，应答 {"app":"bilimusic",...} 的就是电脑端后端。
 * 254 个地址、64 并发、连接超时 250ms——1~2 秒出全量结果。
 */
final class BackendDiscovery {

    /** 与 app/embedded.py 的 DISCOVERY_PORT_DEFAULT 保持一致。 */
    static final int PORT = 8000;

    /** 账号指纹的固定前缀（两端一致即可，避免直接暴露 mid 哈希）。 */
    static final String ACCOUNT_SALT = "bilimusic-lan:";

    /** 一台被发现的后端。 */
    static class Backend {
        final String url;    // http://192.168.x.x:8000
        final String name;   // 对端 hostname（ping 返回）
        final boolean loggedIn;
        final boolean busy;  // 对端有人正在播（自动连接时优先选它）
        final String account; // 账号指纹（#29 自动连接用，见 accountHash）

        Backend(String url, String name, boolean loggedIn, boolean busy, String account) {
            this.url = url;
            this.name = name;
            this.loggedIn = loggedIn;
            this.busy = busy;
            this.account = account == null ? "" : account;
        }
    }

    /** #29：账号指纹——两端用同一算法，比对得上才自动连（不传输明文 mid）。 */
    static String accountHash(String mid) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest((ACCOUNT_SALT + (mid == null ? "" : mid)).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) sb.append(String.format("%02x", d[i] & 0xFF));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private BackendDiscovery() {}

    /** 扫描用的本机 IPv4：优先 wlan/eth 口（真机 Wi-Fi、模拟器 NAT），拿到则返回，否则 null。 */
    private static byte[] localAddress() {
        try {
            byte[] fallback = null;
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress addr : nif.getInterfaceAddresses()) {
                    InetAddress ip = addr.getAddress();
                    if (!(ip instanceof Inet4Address) || ip.isLoopbackAddress()) continue;
                    byte[] a = ip.getAddress();
                    String name = nif.getName() == null ? "" : nif.getName();
                    if (name.startsWith("wlan") || name.startsWith("eth")) return a;
                    if (fallback == null) fallback = a;
                }
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    /** 扫自身所在 /24，返回发现的后端列表（不过滤账号）。阻塞（1~2s），勿在主线程调。 */
    static List<Backend> scan() { return scan(null); }

    /** 扫自身所在 /24，只保留「同一账号且已登录」的后端（wantAccount 为空则只要已登录）。 */
    static List<Backend> scan(String wantAccount) {
        List<Backend> found = Collections.synchronizedList(new ArrayList<>());
        byte[] a = localAddress();
        if (a == null) return found;
        final int o1 = a[0] & 0xFF, o2 = a[1] & 0xFF, o3 = a[2] & 0xFF;
        ExecutorService pool = Executors.newFixedThreadPool(64);
        List<Future<?>> jobs = new ArrayList<>();
        for (int last = 1; last <= 254; last++) {
            final String ip = o1 + "." + o2 + "." + o3 + "." + last;
            jobs.add(pool.submit(() -> {
                Backend b = probe(ip);
                if (b != null) found.add(b);
            }));
        }
        for (Future<?> job : jobs) {
            try { job.get(); } catch (Exception ignored) {}
        }
        pool.shutdownNow();
        List<Backend> mine = new ArrayList<>();
        for (Backend b : found) {
            if (!b.loggedIn) continue;                                        // 对端没登录 B 站账号：连过去也没曲库
            if (wantAccount != null && !wantAccount.isEmpty() && !wantAccount.equals(b.account)) continue;
            mine.add(b);
        }
        Collections.sort(mine, (x, y) -> x.url.compareTo(y.url));
        return mine;
    }

    /** 探测单个 IP：端口通且 ping 应答 app=bilimusic 才算。 */
    static Backend probe(String ip) {
        String url = "http://" + ip + ":" + PORT;
        String body = httpGet(url + "/api/discovery/ping", 250, 600);
        if (body == null) return null;
        try {
            JSONObject json = new JSONObject(body);
            if (!"bilimusic".equals(json.optString("app"))) return null;
            return new Backend(url, json.optString("name", ip), json.optBoolean("loggedIn", false),
                json.optBoolean("busy", false), json.optString("account", ""));
        } catch (Exception e) {
            return null;
        }
    }

    /** 探测已保存的地址是否还活着（启动回连用）。 */
    static boolean alive(String url) {
        return httpGet(url + "/api/discovery/ping", 400, 900) != null;
    }

    private static String httpGet(String url, int connectMs, int readMs) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(connectMs);
            conn.setReadTimeout(readMs);
            if (conn.getResponseCode() != 200) return null;
            try (java.io.InputStream in = conn.getInputStream();
                 java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
