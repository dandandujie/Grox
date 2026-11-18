package browser

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

type dialBrowser func(context.Context, string, string) (net.Conn, error)

var nonPublic = [...]netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("2001::/32"),
}

func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.Zone() != "" {
		return false
	}
	for _, reserved := range nonPublic {
		if reserved.Contains(ip) {
			return false
		}
	}
	return true
}

func dialPublic(ctx context.Context, network, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	local := map[netip.Addr]bool{}
	if interfaces, err := net.InterfaceAddrs(); err == nil {
		for _, iface := range interfaces {
			prefix, err := netip.ParsePrefix(iface.String())
			if err == nil {
				local[prefix.Addr().Unmap()] = true
			}
		}
	}
	for _, ip := range ips {
		if !publicAddress(ip) || local[ip.Unmap()] {
			return nil, errors.New("private or local destinations are unavailable to the managed browser")
		}
	}
	var last error
	for _, ip := range ips {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	if last == nil {
		last = errors.New("the destination did not resolve to a public address")
	}
	return nil, last
}

func startProxy(ctx context.Context, dial dialBrowser) (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	transport := &http.Transport{DialContext: dial, ResponseHeaderTimeout: 20 * time.Second}
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			proxyTunnel(ctx, dial, w, r)
			return
		}
		if r.URL.Scheme != "http" || r.URL.Host == "" || r.URL.User != nil {
			http.Error(w, "managed browser proxy expects an HTTP destination", http.StatusBadRequest)
			return
		}
		out := r.Clone(r.Context())
		out.RequestURI = ""
		clearHopHeaders(out.Header)
		reply, err := transport.RoundTrip(out)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer reply.Body.Close()
		clearHopHeaders(reply.Header)
		for key, values := range reply.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(reply.StatusCode)
		_, _ = io.Copy(w, reply.Body)
	})
	context.AfterFunc(ctx, func() {
		_ = server.Close()
		transport.CloseIdleConnections()
	})
	go func() { _ = server.Serve(listener) }()
	return listener.Addr().String(), nil
}

func clearHopHeaders(headers http.Header) {
	for _, value := range headers.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			headers.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{"Connection", "Proxy-Connection", "Proxy-Authorization", "Proxy-Authenticate", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		headers.Del(name)
	}
}

func proxyTunnel(ctx context.Context, dial dialBrowser, w http.ResponseWriter, r *http.Request) {
	upstream, err := dial(r.Context(), "tcp", r.Host)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer upstream.Close()
	client, wire, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() {
		_ = upstream.Close()
		_ = client.Close()
	})
	defer stop()
	if _, err := wire.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := wire.Flush(); err != nil {
		return
	}
	go func() {
		_, _ = io.Copy(upstream, wire)
		_ = upstream.Close()
	}()
	_, _ = io.Copy(client, upstream)
}
