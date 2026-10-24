import ipaddress

import pytest

from scripts.deployment_smoke import select_smoke_subnets


def test_smoke_avoids_existing_supernets_and_separates_backend_from_proxy():
    occupied = ["172.16.0.0/13", "172.24.0.0/14", "172.30.0.0/16", "fd00::/64"]
    backend, edge = select_smoke_subnets(occupied)
    assert backend.is_private and edge.is_private
    assert backend.prefixlen == edge.prefixlen == 24
    assert not backend.overlaps(edge)
    for subnet in (backend, edge):
        assert all(
            not subnet.overlaps(ipaddress.ip_network(network))
            for network in occupied
            if ":" not in network
        )
        assert subnet.network_address + 2 not in list(subnet.subnets(new_prefix=25))[1]


def test_smoke_falls_back_when_docker_uses_all_172_private_addresses():
    backend, edge = select_smoke_subnets(["172.16.0.0/12"])
    assert backend.subnet_of(ipaddress.ip_network("10.192.0.0/16"))
    assert edge.subnet_of(ipaddress.ip_network("10.192.0.0/16"))


def test_smoke_stops_if_both_pools_are_occupied():
    with pytest.raises(RuntimeError, match="No non-overlapping"):
        select_smoke_subnets(["172.16.0.0/12", "10.0.0.0/8"])
