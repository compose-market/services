/**
 * Docker Multiplexed Stream Parser
 * 
 * Parses the 8-byte header + payload format used by Docker exec streams.
 */

export async function* parseStream(
  stream: NodeJS.ReadableStream
): AsyncGenerator<{ type: "stdout" | "stderr"; data: string }> {
  const { once } = await import("events");
  
  let buffer = Buffer.alloc(0);
  
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  };
  
  stream.on("data", onData);
  
  try {
    await once(stream, "end");
  } finally {
    stream.removeListener("data", onData);
  }
  
  // Parse multiplexed stream (8-byte header + payload)
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    
    const header = buffer.slice(offset, offset + 8);
    const streamType = header[0]; // 0=stdin, 1=stdout, 2=stderr
    const size = header.readUInt32BE(4);
    
    offset += 8;
    
    if (offset + size > buffer.length) break;
    
    const payload = buffer.slice(offset, offset + size).toString("utf-8");
    offset += size;
    
    yield {
      type: streamType === 1 ? "stdout" : "stderr",
      data: payload,
    };
  }
}