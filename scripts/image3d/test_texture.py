import socket
import unittest
from texture import assert_port_available


class PortTest(unittest.TestCase):
    def test_rejects_unrelated_listener(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            server.bind(('127.0.0.1',0));server.listen(1)
            with self.assertRaises(OSError):assert_port_available(server.getsockname()[1])

    def test_reuses_closed_server_connection(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            server.bind(('127.0.0.1',0));server.listen(1)
            port=server.getsockname()[1]
            with socket.create_connection(('127.0.0.1',port)) as client:
                connection,_=server.accept()
                connection.close()  # The server is the active closer.
                self.assertEqual(client.recv(1),b'')
        assert_port_available(port)


if __name__=='__main__':unittest.main()
