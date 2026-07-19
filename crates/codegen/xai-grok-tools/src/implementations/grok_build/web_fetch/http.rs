//! HTTP client construction for `web_fetch`.
//!
//! Each request gets a client pinned to the DNS addresses that passed the SSRF
//! policy. Reusing an unpinned client would reopen a DNS-rebinding window.

use std::net::SocketAddr;

use super::config::WebFetchParams;
use super::error::WebFetchError;

/// Factory for web-fetch clients that share transport settings.
#[derive(Clone, Debug)]
pub(crate) struct HttpClient {
    params: WebFetchParams,
}

impl HttpClient {
    pub(crate) fn new(params: &WebFetchParams) -> Result<Self, WebFetchError> {
        // Validate proxy and TLS client configuration at construction time.
        let _ = Self::build(params)?;
        Ok(Self {
            params: params.clone(),
        })
    }

    /// Build a request client whose DNS result is fixed to addresses that have
    /// already passed the SSRF policy. This closes the validation/request race.
    pub(crate) fn for_resolved_host(
        &self,
        host: &str,
        addrs: &[SocketAddr],
    ) -> Result<reqwest::Client, WebFetchError> {
        Self::builder(&self.params)?
            .resolve_to_addrs(host, addrs)
            .build()
            .map_err(WebFetchError::ClientBuildError)
    }

    fn build(params: &WebFetchParams) -> Result<reqwest::Client, WebFetchError> {
        Self::builder(params)?
            .build()
            .map_err(WebFetchError::ClientBuildError)
    }

    fn builder(params: &WebFetchParams) -> Result<reqwest::ClientBuilder, WebFetchError> {
        let mut builder = reqwest::Client::builder()
            .timeout(params.timeout_secs())
            .connect_timeout(std::time::Duration::from_secs(10))
            // We manage redirects for SSRF.
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .tcp_nodelay(true)
            // Reduce size of incoming payloads.
            .gzip(true)
            .brotli(true)
            .deflate(true);

        // Route all traffic through the egress proxy when configured.
        if let Some(ref endpoint) = params.proxy_endpoint {
            let proxy = reqwest::Proxy::all(endpoint)
                .map_err(|e| WebFetchError::ProxyConfigError(e.to_string()))?;
            builder = builder.proxy(proxy);
        }

        Ok(builder)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_client() {
        let client = HttpClient::new(&WebFetchParams::default()).unwrap();
        let addrs = ["93.184.216.34:443".parse().unwrap()];
        assert!(client.for_resolved_host("example.com", &addrs).is_ok());
    }

    #[test]
    fn build_with_proxy_endpoint() {
        let params = WebFetchParams {
            proxy_endpoint: Some("https://proxy.corp.example.com".into()),
            ..Default::default()
        };
        // Should succeed — reqwest accepts the proxy URL.
        let client = HttpClient::new(&params);
        assert!(client.is_ok());
    }

    #[test]
    fn build_without_proxy_is_default() {
        let params = WebFetchParams::default();
        assert!(params.proxy_endpoint.is_none());
        let client = HttpClient::new(&params);
        assert!(client.is_ok());
    }

    #[test]
    fn build_with_invalid_proxy_endpoint() {
        let params = WebFetchParams {
            proxy_endpoint: Some("not a valid url".into()),
            ..Default::default()
        };
        let result = HttpClient::new(&params);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("proxy"),
            "Expected proxy-related error, got: {err}"
        );
    }
}
