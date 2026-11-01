/** Images named in a message typed in a chat on another machine, put on that machine.
 *
 * A screenshot dropped into the terminal (Termius uploads the file to the machine the terminal is on and types its path) is a path
 * on THIS computer. The chat's agent runs on the other machine, which looks for the path there, finds nothing, and the image never
 * reaches it. Each image the message names -- the same rule a chat here uses (session/attachments.ts embeddedImageReferences) -- is
 * copied to the machine once, and the message goes with the path it has there. The text is otherwise exactly as typed. */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { embeddedImageReferences } from '../session/attachments.js';
import { removeRemoteImage, uploadRemoteImage } from './image.js';

/** What an image may weigh, as for a chat here (attachments.ts). */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export class RemoteImages {
  /** This computer's path -> the path on the machine, for the images already copied. */
  private readonly copied = new Map<string, string>();

  constructor(
    private readonly target: string,
    private readonly workspace: () => string = () => process.cwd(),
    private readonly upload: typeof uploadRemoteImage = uploadRemoteImage,
    private readonly remove: typeof removeRemoteImage = removeRemoteImage,
  ) {}

  /** `text` as the machine should be sent it: every image it names that is a file here, copied there, named as it is there. */
  async forMachine(text: string): Promise<string> {
    let sent = text;
    for (const { token, path } of await embeddedImageReferences(text, this.workspace())) {
      let there = this.copied.get(path);
      if (!there) {
        const info = await stat(path);
        if (info.size > IMAGE_MAX_BYTES) throw new Error(`${basename(path)} is over 20 MiB: images are limited to that.`);
        there = await this.upload(this.target, basename(path), await readFile(path));
        this.copied.set(path, there);
      }
      sent = sent.split(token).join(there);
    }
    return sent;
  }

  /** The copies are taken off the machine when the chat there is left. */
  async release(): Promise<void> {
    const paths = [...this.copied.values()];
    this.copied.clear();
    await Promise.all(paths.map((path) => this.remove(this.target, path).catch(() => undefined)));
  }
}
