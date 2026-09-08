import { describe, expect, it } from "vitest";
import { correctionSchema, numericalGate } from "../server/photo-fit/contracts";

describe("PhotoFit acceptance boundaries", () => {
  const metric = (silhouetteError: number, landmarkError: number | null = null) => ({ silhouetteError, landmarkError, proportionError: null });
  it("does not trade landmark regression for silhouette improvement", () => {
    expect(numericalGate(metric(.3,.03), metric(.2,.06))).toBe(false);
    expect(numericalGate(metric(.3,.03), metric(.2,null))).toBe(false);
    expect(numericalGate(metric(.3,.03), metric(.2,.03))).toBe(true);
  });
  it("rejects noise, missing metrics and nonfinite results", () => {
    expect(numericalGate(metric(.3), metric(.299))).toBe(false);
    expect(numericalGate(metric(.3), metric(NaN))).toBe(false);
    expect(numericalGate(metric(.3), metric(.31))).toBe(false);
  });
  it("accepts a measurable target-region improvement without a global regression", () => {
    expect(numericalGate({...metric(.3),targetRegionError:.2}, {...metric(.3),targetRegionError:.1})).toBe(true);
    expect(numericalGate({...metric(.3),targetRegionError:.2}, {...metric(.32),targetRegionError:.1})).toBe(false);
  });
  it("only permits bounded local geometry operations", () => {
    const operation = { objectId:"x", evidence:"头部过窄", preserve:"眼鼻", center:[.5,.5,.8], radius:[.3,.3,.2], translation:[0,0,0], scale:[1.1,1,1] };
    expect(correctionSchema.safeParse({summary:"修形",parameters:[],operations:[operation]}).success).toBe(true);
    for (const invalid of [{translation:[.2,0,0]}, {scale:[2,1,1]}, {center:[-1,0,0]}, {radius:[NaN,1,1]}, {python:"bpy.ops.wm.open_mainfile()"}]) {
      expect(correctionSchema.safeParse({summary:"",parameters:[],operations:[{...operation,...invalid}]}).success).toBe(false);
    }
    expect(correctionSchema.safeParse({summary:"",parameters:[],operations:Array(4).fill(operation)}).success).toBe(false);
    expect(correctionSchema.safeParse({summary:"",parameters:[],operations:[{...operation,operationType:"deform",smoothIterations:0,smoothFactor:0}]}).success).toBe(true);
    expect(correctionSchema.safeParse({summary:"",parameters:[],operations:[{...operation,operationType:"smooth",smoothIterations:0,smoothFactor:0}]}).success).toBe(false);
  });
});
