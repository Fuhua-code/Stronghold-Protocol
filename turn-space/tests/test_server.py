import importlib.util
import pathlib
import unittest


MODULE = pathlib.Path(__file__).parents[1] / "server.py"
spec = importlib.util.spec_from_file_location("turn_server", MODULE)
turn_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(turn_server)


class TurnServerTests(unittest.TestCase):
    def test_validates_turn_servers_without_logging_credentials(self):
        self.assertTrue(turn_server.valid_ice_servers([
            {"urls": ["stun:stun.cloudflare.com:3478"]},
            {"urls": ["turn:turn.cloudflare.com:443?transport=udp"], "username": "u", "credential": "c"},
        ]))
        self.assertFalse(turn_server.valid_ice_servers([{ "urls": ["stun:stun.cloudflare.com:3478"] }]))
        self.assertFalse(turn_server.valid_ice_servers([{ "urls": ["turn:turn.cloudflare.com:443"] }]))

    def test_ttl_bounds_are_explicit(self):
        self.assertEqual(turn_server.MIN_TTL, 300)
        self.assertEqual(turn_server.MAX_TTL, 1800)


if __name__ == "__main__":
    unittest.main()
