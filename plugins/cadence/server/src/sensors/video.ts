/**
 * Video measurement sensors. ffprobe for metadata, ffmpeg for frame extraction.
 */
import { execa } from "execa";

export type VideoMetadata = {
  durationS: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
};

export async function getMetadata(videoPath: string): Promise<VideoMetadata> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,codec_name:format=duration",
    "-of", "json",
    videoPath,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams[0];
  const [num, den] = String(stream.r_frame_rate).split("/").map(Number);
  return {
    durationS: parseFloat(data.format.duration),
    fps: den ? num / den : num,
    width: stream.width,
    height: stream.height,
    codec: stream.codec_name,
  };
}
