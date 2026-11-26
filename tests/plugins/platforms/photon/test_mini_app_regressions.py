import json

def test_cli_registers_send_mini_app():
    import argparse
    from plugins.platforms.photon.cli import register_cli
    parser = argparse.ArgumentParser()
    register_cli(parser)
    args = parser.parse_args(['send-mini-app', '--to', 'any;-;+15551234567', '--url', 'https://example.test/app'])
    assert args.photon_command == 'send-mini-app'


def test_cli_dispatches_to_live_sidecar(monkeypatch, capsys):
    import argparse
    import httpx
    from plugins.platforms.photon import cli, adapter
    calls = []
    def request(req):
        calls.append(req)
        return httpx.Response(200, json={'ok': True, 'messageId': 'card-1'})
    real_client = httpx.Client
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(request)))
    monkeypatch.setattr(adapter, '_get_scoped_secret', lambda name: 'token' if name == 'PHOTON_SIDECAR_TOKEN' else None)
    parser = argparse.ArgumentParser()
    cli.register_cli(parser)
    args = parser.parse_args(['send-mini-app', '--to', 'any;-;+15551234567', '--url', 'https://example.test/app'])
    assert cli.dispatch(args) == 0
    assert calls[0].url.path == '/send-mini-app'
    assert json.loads(calls[0].content) == {'spaceId': args.to, 'url': args.url}
    assert 'card-1' in capsys.readouterr().out


def test_cli_uses_profile_configured_port_with_token(monkeypatch, tmp_path):
    import argparse
    import httpx
    from plugins.platforms.photon import cli
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("PHOTON_SIDECAR_TOKEN", "test-token")
    monkeypatch.delenv("PHOTON_SIDECAR_PORT", raising=False)
    (tmp_path / "config.yaml").write_text("platforms:\n  photon:\n    enabled: true\n    extra:\n      sidecar_port: 19543\n")
    calls = []
    real_client = httpx.Client
    def request(req):
        calls.append(req)
        return httpx.Response(200, json={"ok": True})
    monkeypatch.setattr(cli.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(request)))
    assert cli._cmd_send_mini_app(argparse.Namespace(to="fixture", url="https://example.test/")) == 0
    assert calls[0].url.port == 19543


def test_cli_warns_500_delivery_is_uncertain(monkeypatch, capsys, tmp_path):
    import argparse
    import httpx
    from plugins.platforms.photon import cli
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("PHOTON_SIDECAR_TOKEN", "test-token")
    real_client = httpx.Client
    monkeypatch.setattr(cli.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(
        lambda req: httpx.Response(500, json={"ok": False}))))
    assert cli._cmd_send_mini_app(argparse.Namespace(to="fixture", url="https://example.test/")) == 1
    err = capsys.readouterr().err.lower()
    assert "uncertain" in err and "do not retry blindly" in err


def test_cli_timeout_warns_against_blind_retry(monkeypatch, capsys, tmp_path):
    import argparse
    import httpx
    from plugins.platforms.photon import cli
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("PHOTON_SIDECAR_TOKEN", "test-token")
    real_client = httpx.Client
    def timeout(req):
        raise httpx.ReadTimeout("timeout", request=req)
    monkeypatch.setattr(cli.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(timeout)))
    assert cli._cmd_send_mini_app(argparse.Namespace(to="fixture", url="https://example.test/")) == 1
    err = capsys.readouterr().err.lower()
    assert "uncertain" in err and "do not retry blindly" in err
