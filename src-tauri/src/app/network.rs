use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    sync::Arc,
};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::{Host, Url};

const MAX_RESOLVED_ADDRESSES: usize = 32;

pub(crate) fn ipv4_is_non_public(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && matches!(octets[1], 18 | 19))
        || [
            (u32::from_be_bytes([192, 0, 0, 0]), 24),
            (u32::from_be_bytes([192, 88, 99, 0]), 24),
            (u32::from_be_bytes([240, 0, 0, 0]), 4),
        ]
        .into_iter()
        .any(|(network, prefix)| ipv4_in_prefix(address, network, prefix))
}

fn ipv4_in_prefix(address: Ipv4Addr, network: u32, prefix: u32) -> bool {
    let mask = u32::MAX << (32 - prefix);
    u32::from(address) & mask == network & mask
}

fn validate_public_resolved_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> io::Result<Vec<SocketAddr>> {
    let mut public = Vec::new();
    for address in addresses {
        if public.len() == MAX_RESOLVED_ADDRESSES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "DNS returned too many addresses",
            ));
        }
        if ip_is_non_public(address.ip()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "DNS returned a local or reserved address",
            ));
        }
        public.push(address);
    }
    if public.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "DNS returned no addresses",
        ));
    }
    Ok(public)
}

fn resolve_public_addresses(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    validate_public_resolved_addresses((host, port).to_socket_addrs()?)
}

/// Resolver for reqwest that checks and returns the same OS-resolved addresses
/// the connector will use. A later DNS answer is not consulted for that
/// connection attempt.
pub(crate) struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = resolve_public_addresses(&host, 0)?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

pub(crate) fn public_dns_resolver() -> Arc<PublicDnsResolver> {
    Arc::new(PublicDnsResolver)
}

pub(crate) fn ipv6_is_non_public(address: Ipv6Addr) -> bool {
    let first = address.segments()[0];
    let value = u128::from(address);
    address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || first & 0xfe00 == 0xfc00
        || first & 0xffc0 == 0xfe80
        || address.to_ipv4().is_some_and(ipv4_is_non_public)
        || first & 0xe000 != 0x2000
        || [
            (
                u128::from_be_bytes([0x20, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                23,
            ),
            (
                u128::from_be_bytes([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                32,
            ),
            (
                u128::from_be_bytes([0x20, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                16,
            ),
            (
                u128::from_be_bytes([0x3f, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                20,
            ),
        ]
        .into_iter()
        .any(|(network, prefix)| value >> (128 - prefix) == network >> (128 - prefix))
}

pub(crate) fn ip_is_non_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => ipv4_is_non_public(address),
        IpAddr::V6(address) => ipv6_is_non_public(address),
    }
}

pub(crate) fn host_is_public(host: &str) -> bool {
    // `Url::host_str()` may preserve square brackets around IPv6 literals.
    // Normalize them before parsing so loopback, link-local and unique-local
    // IPv6 targets cannot bypass the SSRF guard.
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".lan")
        || host.ends_with(".internal")
    {
        return false;
    }
    host.parse::<IpAddr>()
        .map(|address| !ip_is_non_public(address))
        .unwrap_or(true)
}

pub(crate) fn url_has_public_http_target(parsed: &Url) -> bool {
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return false;
    }
    if progress_acceptance_url_allowed(parsed) {
        return true;
    }
    match parsed.host() {
        Some(Host::Domain(host)) => host_is_public(host),
        Some(Host::Ipv4(address)) => !ipv4_is_non_public(address),
        Some(Host::Ipv6(address)) => !ipv6_is_non_public(address),
        None => false,
    }
}

fn progress_acceptance_url_allowed(parsed: &Url) -> bool {
    if cfg!(debug_assertions)
        && std::env::var("CACATOOLS_MEDIA_E2E_ACCEPTANCE")
            .map(|value| value.trim() == "1")
            .unwrap_or(false)
    {
        if let Ok(urls) = std::env::var("CACATOOLS_MEDIA_E2E_URLS") {
            if urls
                .split('|')
                .filter_map(|value| Url::parse(value.trim()).ok())
                .any(|fixture| {
                    parsed.origin() == fixture.origin()
                        && parsed.path() == fixture.path()
                        && parsed.query() == fixture.query()
                })
            {
                return true;
            }
        }
    }
    if !cfg!(debug_assertions)
        || std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE")
            .map(|value| value.trim() != "1")
            .unwrap_or(true)
    {
        return false;
    }
    let Ok(fixture) = std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE_URL") else {
        return false;
    };
    let Ok(fixture) = Url::parse(fixture.trim()) else {
        return false;
    };
    parsed.origin() == fixture.origin()
        && parsed.path() == fixture.path()
        && parsed.query() == fixture.query()
}

pub(crate) fn parse_public_http_url(value: &str, invalid_message: &str) -> Result<Url, String> {
    let mut parsed = Url::parse(value.trim()).map_err(|_| invalid_message.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Solo se permiten enlaces HTTP o HTTPS".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("El enlace no puede incluir credenciales".into());
    }
    if !url_has_public_http_target(&parsed) && !progress_acceptance_url_allowed(&parsed) {
        return Err("El enlace apunta a una dirección local o privada no permitida".into());
    }
    parsed.set_fragment(None);
    Ok(parsed)
}

pub(crate) fn ensure_public_network_resolution(parsed: &Url) -> Result<(), String> {
    if progress_acceptance_url_allowed(parsed) {
        return Ok(());
    }
    let host = match parsed.host() {
        Some(Host::Ipv4(address)) => {
            return if ipv4_is_non_public(address) {
                Err("El host resuelve a una dirección local o privada no permitida".into())
            } else {
                Ok(())
            };
        }
        Some(Host::Ipv6(address)) => {
            return if ipv6_is_non_public(address) {
                Err("El host resuelve a una dirección local o privada no permitida".into())
            } else {
                Ok(())
            };
        }
        Some(Host::Domain(host)) => host,
        None => return Err("El enlace no contiene un host válido".into()),
    };
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "No se pudo determinar el puerto del enlace".to_string())?;
    resolve_public_addresses(host, port)
        .map(|_| ())
        .map_err(|error| match error.kind() {
            io::ErrorKind::PermissionDenied => {
                "El host resuelve a una dirección local o privada no permitida".into()
            }
            io::ErrorKind::AddrNotAvailable => {
                "El host no devolvió ninguna dirección de red".into()
            }
            _ => format!("No se pudo resolver el host de forma segura: {error}"),
        })
}

pub(crate) fn url_has_public_network_target(parsed: &Url) -> bool {
    url_has_public_http_target(parsed) && ensure_public_network_resolution(parsed).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_reserved_ipv4_ranges() {
        for value in ["192.0.0.8", "192.88.99.1", "240.0.0.1", "255.255.255.255"] {
            let address = value.parse().expect("valid IPv4 fixture");
            assert!(ipv4_is_non_public(address), "accepted reserved {value}");
        }
        assert!(!ipv4_is_non_public("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn rejects_non_global_and_reserved_ipv6_ranges() {
        for value in [
            "2001:db8::1",
            "2001::1",
            "2002::1",
            "3fff::1",
            "64:ff9b::808:808",
        ] {
            let address = value.parse().expect("valid IPv6 fixture");
            assert!(ipv6_is_non_public(address), "accepted reserved {value}");
        }
        assert!(!ipv6_is_non_public("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn rejects_mixed_public_and_private_dns_answers() {
        let answers = [
            SocketAddr::from(([8, 8, 8, 8], 443)),
            SocketAddr::from(([127, 0, 0, 1], 443)),
        ];
        assert_eq!(
            validate_public_resolved_addresses(answers)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn validated_dns_answers_are_returned_unchanged_for_connection_pinning() {
        let answers = [
            SocketAddr::from(([8, 8, 8, 8], 0)),
            SocketAddr::from(("2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap(), 0)),
        ];
        assert_eq!(
            validate_public_resolved_addresses(answers).unwrap(),
            answers
        );
    }
}
