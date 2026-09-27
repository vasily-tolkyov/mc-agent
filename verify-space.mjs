/** 空间层离线验证：罗盘环 bump 自维持/平移可控、路径积分、扇区映射。 */
import { CompassRing, PathIntegrator, bearingSector } from './mind/space.mjs';

const ring = new CompassRing({});
ring.ignite(16);
let p = ring.position();
console.log(`点燃环位 16 → bump 质心 ${p.toFixed(1)}（应≈16）`);
for (let k = 0; k < 10; k++) ring.step(8); // 静置
const p2 = ring.position();
console.log(`静置 80 步后 ${p2.toFixed(1)}（自维持，应≈16）`);
ring.shift(Math.PI / 2); // 转 90°
const p3 = ring.position();
console.log(`shift(+90°) 后 ${p3.toFixed(1)}（应≈16+16=32）`);
ring.shift(-Math.PI / 2);
console.log(`shift(-90°) 后 ${ring.position().toFixed(1)}（应≈16）`);

const pi = new PathIntegrator();
pi.forward(0, 3.4);
console.log(`前进 3.4m 航向0 → (${pi.x.toFixed(2)}, ${pi.z.toFixed(2)})（应 (0, 3.4)，视觉约定 dz=+cos）`);
const bd = pi.bearingDist(0, 0);
console.log(`回望起点：角度 ${bd.angle.toFixed(2)}（≈π 后方），距离 ${bd.dist.toFixed(2)}`);
console.log(`正前方目标扇区：${bearingSector(0, 0)}（应=4）｜正后方：${bearingSector(Math.PI, 0)}（应=0或8）`);
