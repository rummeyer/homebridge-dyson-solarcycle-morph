/**
 * What a lamp draws from the wall, worked out from what it is set to.
 *
 * The lamp measures nothing of the kind and says nothing about it over BLE, so
 * this is a table: one CD06 on a metering plug on 2026-10-14, stepped through
 * brightness and colour temperature with everything else on that socket held
 * still, each step the median of fourteen readings after the lamp had settled.
 * Readings varied by ±0.2 W within a step.
 *
 * Draw rises with brightness up to about 75 % and then stops: at 100 % the lamp
 * takes 11 W at any colour temperature, against Dyson's rated 11.2 W. Colour
 * temperature matters only in between, where warm takes up to 1.4 W more.
 */

/** Product type of the CD06 desk light, the one model the table was measured on. */
export const CD06_PRODUCT_TYPE = '552';

/** Lamp off but plugged in, measured by pulling its power supply. */
export const STANDBY_WATTS = 0.3;

const PERCENTS = [0, 10, 25, 50, 75, 100];
const KELVINS = [2700, 4600, 6500];

/**
 * Watts drawn above standby, by colour temperature then brightness.
 * Rows follow {@link KELVINS}, columns {@link PERCENTS}.
 */
const CD06_WATTS = [
  [1.3, 2.85, 5.0, 9.0, 10.9, 11.0],
  [1.5, 2.7, 4.7, 8.0, 10.9, 10.9],
  [1.35, 2.35, 4.45, 7.6, 10.95, 11.05],
];

/** Where `value` falls in `steps`: the index below it, and how far towards the next. */
function locate(steps: number[], value: number): [number, number] {
  const clamped = Math.min(steps[steps.length - 1]!, Math.max(steps[0]!, value));
  let index = 0;
  while (index < steps.length - 2 && clamped > steps[index + 1]!) {
    index++;
  }
  return [index, (clamped - steps[index]!) / (steps[index + 1]! - steps[index]!)];
}

/**
 * The lamp's draw in watts, or `undefined` for a model nobody has measured.
 *
 * @param productType what the lamp reports in its product info
 * @param brightness HomeKit brightness, 0-100 %
 */
export function estimateWatts(
  productType: string | undefined,
  state: { on: boolean; brightness: number; kelvin: number },
): number | undefined {
  if (productType !== CD06_PRODUCT_TYPE) {
    return undefined;
  }
  if (!state.on) {
    return STANDBY_WATTS;
  }
  const [row, rowFraction] = locate(KELVINS, state.kelvin);
  const [column, columnFraction] = locate(PERCENTS, state.brightness);
  const along = (watts: number[]): number =>
    watts[column]! + (watts[column + 1]! - watts[column]!) * columnFraction;
  const lower = along(CD06_WATTS[row]!);
  const upper = along(CD06_WATTS[row + 1]!);
  return Math.round((STANDBY_WATTS + lower + (upper - lower) * rowFraction) * 100) / 100;
}
