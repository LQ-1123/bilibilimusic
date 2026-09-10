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

    /** 一台被发现的后端。 */
    static class Backend {
        final String url;   // http://192.168.x.x:8000
        final String name;  // 对端 hostname（ping 返回）
        final boolean loggedIn;

        Backend(String url, String name, boolean loggedIn) {
            this.url = url;
            this.name = name;
            this.loggedIn = loggedIn;
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

    /** 扫自身所在 /24，返回发现的后端列表。阻塞（1~2s），勿在主线程调。 */
    static List<Backend> scan() {
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
        Collections.sort(found, (x, y) -> x.url.compareTo(y.url));
        return found;
    }

    /** 探测单个 IP：端口通且 ping 应答 app=bilimusic 才算。 */
    static Backend probe(String ip) {
        String url = "http://" + ip + ":" + PORT;
        String body = httpGet(url + "/api/discovery/ping", 250, 600);
        if (body == null) return null;
        try {
            JSONObject json = new JSONObject(body);
            if (!"bilimusic".equals(json.optString("app"))) return null;
            return new Backend(url, json.optString("name", ip), json.optBoolean("loggedIn", false));
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
