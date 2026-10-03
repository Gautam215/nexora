import { createServer } from "node:net";

export interface SmtpCapture {
  port: number;
  messages: string[];
  close(): Promise<void>;
}

export async function startSmtpCaptureServer(): Promise<SmtpCapture> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 nexora-test ESMTP\r\n");
    let buffer = "";
    let readingData = false;

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        if (readingData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          readingData = false;
          socket.write("250 queued\r\n");
          continue;
        }

        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^(EHLO|HELO) /i.test(command)) socket.write("250 nexora-test\r\n");
        else if (/^MAIL FROM:/i.test(command) || /^RCPT TO:/i.test(command)) {
          socket.write("250 accepted\r\n");
        } else if (/^DATA$/i.test(command)) {
          readingData = true;
          socket.write("354 send message\r\n");
        } else if (/^RSET$/i.test(command)) socket.write("250 reset\r\n");
        else if (/^QUIT$/i.test(command)) {
          socket.write("221 closing\r\n");
          socket.end();
        } else socket.write("250 accepted\r\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");

  return {
    port: address.port,
    messages,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
