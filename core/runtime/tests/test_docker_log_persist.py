"""Workload logs are copied to VEXA_WORKLOAD_LOG_DIR before the container is removed (docker demux)."""
from runtime_kernel.docker_backend import _demux_docker_log


def test_demux_strips_frame_headers():
    raw = b"\x01\x00\x00\x00\x00\x00\x00\x05hello" + b"\x02\x00\x00\x00\x00\x00\x00\x06 world"
    assert _demux_docker_log(raw) == b"hello world"


def test_demux_passes_tty_stream_through():
    raw = b"[voxtral] idle close\n[voxtral] starved\n"
    assert _demux_docker_log(raw) == raw


def test_stream_demux_handles_frames_straddling_reads():
    import io
    from runtime_kernel.docker_backend import _demux_docker_stream
    frames = b"".join(bytes([k, 0, 0, 0]) + len(p).to_bytes(4, "big") + p
                      for k, p in ((1, b"hello "), (2, b"world\n"), (1, b"x" * 5000)))

    class Trickle(io.RawIOBase):  # 3-byte reads → every frame straddles a boundary
        def __init__(self, b): self.b, self.i = b, 0
        def read(self, n=-1):
            out = self.b[self.i:self.i + 3]; self.i += 3; return out

    assert b"".join(_demux_docker_stream(Trickle(frames))) == b"hello world\n" + b"x" * 5000
    assert b"".join(_demux_docker_stream(io.BytesIO(b"plain tty bytes"))) == b"plain tty bytes"
