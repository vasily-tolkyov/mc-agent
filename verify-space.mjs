/** 空间层离线验证：罗盘环 bump 自维持/平移可控、路径积分、扇区映射。运行：node verify-space.mjs */
import { CompassRing, PathIntegrator, bearingSector } from './mind/space.mjs';

const checks = [];
const check = (name, ok, detail) => { checks.push(ok); console.log(`${name}${detail ? `（${detail}）` : ''} → ${ok ? '✓' : '✗'}`); };
const ringNear = (a, b, tol = 1.0) => { const d = Math.abs(a - b) % 64; return Math.min(d, 64 - d) <= tol; }; // 环距 ≤ tol

const ring = new CompassRing({});
ring.ignite(16);
const p = ring.position();
check('点燃环位 16 → bump 质心', ringNear(p, 16), `${p.toFixed(1)}，应≈16`);
for (let k = 0; k < 10; k++) ring.step(8); // 静置
const p2 = ring.position();
check('静置 80 步后自维持', ringNear(p2, 16), `${p2.toFixed(1)}，应≈16`);
ring.shift(Math.PI / 2); // 转 90°
const p3 = ring.position();
check('shift(+90°) 后', ringNear(p3, 32), `${p3.toFixed(1)}，应≈32`);
ring.shift(-Math.PI / 2);
const p4 = ring.position();
check('shift(-90°) 后', ringNear(p4, 16), `${p4.toFixed(1)}，应≈16`);

const pi = new PathIntegrator();
pi.forward(0, 3.4);
check('前进 3.4m 航向 0 → (0, 3.4)（视觉约定 dz=+cos）', Math.abs(pi.x) < 1e-9 && Math.abs(pi.z - 3.4) < 1e-9, `(${pi.x.toFixed(2)}, ${pi.z.toFixed(2)})`);
const bd = pi.bearingDist(0, 0);
check('回望起点：角度≈±π、距离 3.4', Math.abs(Math.abs(bd.angle) - Math.PI) < 1e-6 && Math.abs(bd.dist - 3.4) < 1e-9, `角度 ${bd.angle.toFixed(2)}，距离 ${bd.dist.toFixed(2)}`);
check('正前方目标扇区 = 4', bearingSector(0, 0) === 4, `${bearingSector(0, 0)}`);
const back = bearingSector(Math.PI, 0);
check('正后方目标扇区 ∈ {0, 8}', back === 0 || back === 8, `${back}`);

const ok = checks.every(Boolean);
console.log(ok ? '\n✓ 空间层 8/8' : `\n✗ 空间层 ${checks.filter(Boolean).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
