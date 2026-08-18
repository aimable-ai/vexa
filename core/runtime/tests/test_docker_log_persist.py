"""Workload logs are copied to VEXA_WORKLOAD_LOG_DIR before the container is removed (docker demux)."""
from runtime_kernel.docker_backend import _demux_docker_log


def test_demux_strips_frame_headers():
    raw = b"\x01\x00\x00\x00\x00\x00\x00\x05hello" + b"\x02\x00\x00\x00\x00\x00\x00\x06 world"
    assert _demux_docker_log(raw) == b"hello world"


def test_demux_passes_tty_stream_through():
    raw = b"[voxtral] idle close\n[voxtral] starved\n"
    assert _demux_docker_log(raw) == raw
