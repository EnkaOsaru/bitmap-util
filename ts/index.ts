import * as fs from 'fs';
import * as path from 'path';
import { execute } from '@getvim/execute';
import { createCanvas, loadImage } from 'canvas';
import { group } from 'console';

class Bitmap {
  readonly number: number;
  readonly data: string;

  constructor(number: number, data: string) {
    this.number = number;
    this.data = data;
  }

  async writeImage(path: string) {
    const imageData = Bitmap.context.createImageData(28, 28);
    for (let i = 0; i < this.data.length; i++) {
      const value = this.data[i] === '0' ? 255 : 0;
      imageData.data[4 * i + 0] = value;
      imageData.data[4 * i + 1] = value;
      imageData.data[4 * i + 2] = value;
      imageData.data[4 * i + 3] = 255;
    }
    Bitmap.context.putImageData(imageData, 0, 0);
    const buffer = Bitmap.canvas.toBuffer('image/png');
    fs.writeFileSync(path, buffer);
  }

  toString() {
    return `${this.number}\n${this.data}\n`;
  }

  static canvas = createCanvas(28, 28);
  static context = Bitmap.canvas.getContext('2d');

  static fromData(number: number, data: string) {
    return new Bitmap(number, data);
  }

  static async fromImage(number: number, path: string) {
    const image = await loadImage(path);
    Bitmap.context.drawImage(image, 0, 0);
    const imageData = Bitmap.context.getImageData(0, 0, 28, 28);
    const area = imageData.width * imageData.height;
    let data = '';
    for (let i = 0; i < area; i++) {
      data += imageData.data[4 * i] === 0 ? '1' : '0';
    }
    return new Bitmap(number, data);
  }
}

class BitmapGroup {
  number: number;
  bitmaps: Bitmap[];

  constructor(number: number, bitmaps: Bitmap[] = []) {
    this.number = number;
    this.bitmaps = bitmaps;
  }

  async writeImages(dir: string) {
    for (let i = 0; i < this.bitmaps.length; i++) {
      const name = ('000000000' + i).replace(/^.*?(.{10})$/, '$1.png');
      const bitmap = this.bitmaps[i];
      await bitmap.writeImage(path.join(dir, name));
    }
  }

  toString() {
    return this.bitmaps.join('');
  }

  static fromFile(path: string) {
    const string = '' + fs.readFileSync(path);
    const lines = string.trim().split('\n');
    const bitmaps: Bitmap[] = [];
    for (let i = 0; i < lines.length; i += 2) {
      const number = +lines[i];
      const data = lines[i + 1];
      bitmaps.push(Bitmap.fromData(number, data));
    }
    const groups = new Array(10).fill(0).map((_, i) => new BitmapGroup(i));
    for (const bitmap of bitmaps) {
      groups[bitmap.number].bitmaps.push(bitmap);
    }
    return groups;
  }

  static async fromImages(number: number, dir: string) {
    const group = new BitmapGroup(number);
    const paths = fs.readdirSync(dir).filter(e => e.endsWith('png'));
    for (const e of paths) {
      const bitmap = await Bitmap.fromImage(number, path.join(dir, e));
      group.bitmaps.push(bitmap);
    }
    return group;
  }
}

type Action = { name: string, invoke: (pathIn: string, pathOut: string) => void };

const actions: Action[] = [
  {
    name: 'to-image',
    invoke: async (pathIn: string, pathOut: string) => {
      const groups = BitmapGroup.fromFile(pathIn);
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.bitmaps.length === 0) continue;
        const subDir = path.join(pathOut, '' + i);
        await execute(`mkdir -p ${subDir}`);
        group.writeImages(subDir);
      }
    }
  },
  {
    name: 'shuffle',
    invoke: (pathIn: string, pathOut: string) => {
      const groups = BitmapGroup.fromFile(pathIn);
      const bitmaps = groups.reduce((a, e) => [...a, ...e.bitmaps], new Array<Bitmap>());
      const shuffled = new Array<Bitmap>(bitmaps.length);
      for (let i = 0; i < shuffled.length; i++) {
        const index = bitmaps.length * Math.random() | 0;
        shuffled[i] = bitmaps.splice(index, 1)[0];
      }
      const result = shuffled.join('');
      fs.writeFileSync(pathOut, result);
    }
  },
  {
    name: 'inflate',
    invoke: async (pathIn: string, pathOut: string) => {
      let result = '';

      const tempDir = `temp-${Date.now()}`;
      await execute(`mkdir ${tempDir}`);

      const groups = BitmapGroup.fromFile(pathIn);
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.bitmaps.length === 0) {
          continue;
        }

        const subDir = path.join(tempDir, '' + i);
        await execute(`mkdir ${subDir}`);

        await group.writeImages(subDir);
        await execute(`
          ffmpeg 
            -i "${subDir}/%010d.png"
            -filter_complex "
              pad =
                w = iw + 2 :
                h = ih + 2 :
                x = -1 :
                y = -1 :
                color = #ffffff
            "
            "${subDir}/pad-%010d.png"
        `.replace(/\n/g, ''));
        await execute(`rm -rf $(find ${subDir} -type f | egrep "/\\d+\\.png")`);
        await execute(`ffmpeg -i "${subDir}/pad-%010d.png" -vf "crop=28:28:0:0" "${subDir}/lt-%010d.png"`);
        await execute(`ffmpeg -i "${subDir}/pad-%010d.png" -vf "crop=28:28:2:0" "${subDir}/rt-%010d.png"`);
        await execute(`ffmpeg -i "${subDir}/pad-%010d.png" -vf "crop=28:28:0:2" "${subDir}/lb-%010d.png"`);
        await execute(`ffmpeg -i "${subDir}/pad-%010d.png" -vf "crop=28:28:2:2" "${subDir}/rb-%010d.png"`);
        // await execute(`rm -rf $(find ${subDir} -type f | egrep "/pad-")`);

        const newGroup = await BitmapGroup.fromImages(i, subDir);
        result += newGroup;
      }

      fs.writeFileSync(pathOut, result);
      await execute(`rm -rf ${tempDir}`);
    }
  }
];

(() => {
  const actionName = process.argv[2];
  const pathIn = process.argv[3];
  const pathOut = process.argv[4];

  for (const action of actions) {
    if (action.name === actionName) {
      action.invoke(pathIn, pathOut);
    }
  }
})();