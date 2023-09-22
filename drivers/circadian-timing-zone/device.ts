import { CircadianTimingDriver } from './driver'

type TimeValue = {
  brightness: string;
  temperature: string;
};

interface Timing {
  [index: string]: TimeValue
};

type Time = {
  hours: number;
  minutes: number;
};

interface TimingItem {
  time: Time,
  value: TimeValue,
}

export class CircadianTimingZone extends require('../circadian-zone/device') {

  private _timings: TimingItem[] = [];
  private _nightTimings: TimingItem[] = [];
  private _fadeDuration: number = -1;

  async onSettings(event: {
    newSettings: { timing: string, night_timing: string, fade_duration: number },
    changedKeys: string[]
  }): Promise<string | void> {
    if (event.changedKeys.includes('timing')) {
      if (!this._validateTiming(event.newSettings.timing)) {
        return this.homey.__("json_timing_error");
      }
      this._timings = this._parseTiming(event.newSettings.timing);
    }
    if (event.changedKeys.includes('night_timing')) {
      if (!this._validateTiming(event.newSettings.night_timing)) {
        return this.homey.__("json_timing_error");
      }
      this._nightTimings = this._parseTiming(event.newSettings.night_timing);
    }
    if (event.changedKeys.includes('fade_duration')) {
      this._fadeDuration = event.newSettings.fade_duration;
    }
    await super.onSettings(event);
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {

    this._timings = this._parseTiming(await this.getSetting("timing"));
    this._nightTimings = this._parseTiming(await this.getSetting("night_timing"));

    // Mode Listener
    this.registerCapabilityListener("adaptive_mode", async (value: any) => {
      this.log(`Mode changed to ${value}`)
      await this.setMode(value);
    });

    // Temperature Override Listener
    this.registerCapabilityListener("light_temperature", async (value: any) => {
      this.log(`Temperature override to ${value}`);
      await this.overrideCurrentTemperature(value);
    });

    // Dim Override Listener
    this.registerCapabilityListener("dim", async (value: any) => {
      this.log(`Dim override to ${value}`);
      await this.overrideCurrentBrightness(value);
    });

    this.log('CircadianTimingZone has been initialized');
    this.refreshZone();
  }

  /**
   * refreshZone updates the zone values, based on mode and circadian progress
   */
  async refreshZone() {
    const mode = await this.getMode();
    if (mode == "adaptive") {
      if (this._timings.length < 2) {
        super.refreshZone();
        return;
      }
    } else if (mode == "night") {
      if (this._nightTimings.length < 2) {
        super.refreshZone();
        return;
      }
    } else {
      return;
    }

    let valuesChanged: boolean = false;
    const date = new Date()
    const currentTime: Time = this._dateToLocalTime(date);
    const prevItem = this._findPrevItem(currentTime, mode);
    const nextItem = this._findNextItem(currentTime, mode);

    let brightness: number = -1;
    if (prevItem.value.brightness === 'circadian' && nextItem.value.brightness === 'circadian') {
      brightness = await this._calcCircadianBrightness(mode);
    } else {
      const fade = await this._calcPrevNextFade(prevItem, nextItem)
      const prevBrightness = await this._calcItemPrevBrightness(prevItem, mode);
      const nextBrightness = await this._calcItemBrightness(nextItem, mode);
      brightness = prevBrightness * (1 - fade) + nextBrightness * fade;
    }

    let temperature: number = -1;
    if (prevItem.value.temperature === 'circadian' && nextItem.value.temperature === 'circadian') {
      temperature = await this._calcCircadianTemperature(mode);
    } else {
      const fade = await this._calcPrevNextFade(prevItem, nextItem)
      const prevTemperature = await this._calcItemPrevTemperature(prevItem, mode);
      const nextTemperature = await this._calcItemTemperature(nextItem, mode);
      temperature = prevTemperature * (1 - fade) + nextTemperature * fade;
    }

    let currentBrightness = await this.getCurrentBrightness();
    if (brightness != currentBrightness) {
      this._currentBrightness = brightness;
      await this.setCapabilityValue("dim", brightness);
      valuesChanged = true;
    }
    const currentTemperature = await this.getCurrentTemperature();

    if (temperature != currentTemperature) {
      this._currentTemperature = temperature;
      await this.setCapabilityValue("light_temperature", temperature);
      valuesChanged = true;
    } else {
      this.log(`No change in temperature from ${this._currentTemperature}%`)
    }

    // Trigger flow if appropriate
    if (valuesChanged) {
      await this.triggerValuesChangedFlow(brightness, temperature);
    }
  }

  async getFadeDuration(): Promise<number> {
    if (this._fadeDuration == -1) {
      this._fadeDuration = await this.getSetting("fade_duration");
    }
    return this._fadeDuration;
  }

  async _calcCircadianBrightness(mode: string, date?: Date) {
    if (mode === 'night') {
      return await this.getNightBrightness();
    }
    const percentage = (this.driver as CircadianTimingDriver).getPercentageForDate(date);
    const minBrightness: number = await this.getMinBrightness();
    const maxBrightness: number = await this.getMaxBrightness();
    const brightnessDelta = maxBrightness - minBrightness;
    return (percentage > 0) ? (brightnessDelta * percentage) + minBrightness : minBrightness;
  }

  async _calcCircadianTemperature(mode: string, date?: Date) {
    if (mode === 'night') {
      return await this.getNightTemperature();
    }
    const percentage = (this.driver as CircadianTimingDriver).getPercentageForDate(date);
    const sunsetTemp: number = await this.getSunsetTemperature();
    const noonTemp: number = await this.getNoonTemperature();
    const tempDelta = sunsetTemp - noonTemp;
    let calculatedTemperature = (tempDelta * (1 - percentage)) + noonTemp;
    return (percentage > 0) ? calculatedTemperature : sunsetTemp;
  }

  async _calcPrevNextFade(prevItem: TimingItem, nextItem: TimingItem) {
    let diff = this._timeToInt(nextItem.time) - this._timeToInt(prevItem.time)
    if (diff < 0) {
      diff = 24 * 60 - diff;
    }

    const fadeDuration = Math.min(await this.getFadeDuration(), diff);

    const currentTime: Time = this._dateToLocalTime(new Date());

    diff = this._timeToInt(nextItem.time) - this._timeToInt(currentTime)
    if (diff < 0) {
      diff = 24 * 60 - diff;
    }

    if (diff > fadeDuration) {
      return 0;
    }
    return (fadeDuration - diff) / fadeDuration;
  }

  _dateToLocalTime(date: Date) {
    return this._parseTime(
      date.toLocaleString('en-UK',
        { minute: 'numeric', hour: 'numeric', timeZone: this.homey.clock.getTimezone() }
      )
    );
  }

  async _calcItemBrightness(item: TimingItem, mode: string) {
    if (item.value.brightness === 'circadian') {
      const date = new Date()
      const currentTime = this._dateToLocalTime(date);

      const diff = this._timeToInt(item.time) - this._timeToInt(currentTime)
      date.setMinutes(date.getMinutes() + diff);

      return await this._calcCircadianBrightness(mode, date)
    }
    return parseFloat(item.value.brightness);
  }

  async _calcItemPrevBrightness(item: TimingItem, mode: string) {
    if (item.value.brightness === 'circadian') {

      return await this._calcCircadianBrightness(mode)
    }
    return parseFloat(item.value.brightness);
  }

  async _calcItemPrevTemperature(item: TimingItem, mode: string) {
    if (item.value.temperature === 'circadian') {
      return await this._calcCircadianTemperature(mode)
    }
    return parseFloat(item.value.temperature);
  }
  
  async _calcItemTemperature(item: TimingItem, mode: string) {
    if (item.value.temperature === 'circadian') {
      const date = new Date()
      const currentTime: Time = this._dateToLocalTime(date);

      const diff = this._timeToInt(item.time) - this._timeToInt(currentTime)
      date.setMinutes(date.getMinutes() + diff);

      return await this._calcCircadianTemperature(mode, date)
    }
    return parseFloat(item.value.temperature);
  }

  _timeToInt(time: Time) {
    return time.hours * 60 + time.minutes;
  }

  _findPrevItem(time: Time, mode: string) {
    let arr = this._getTimingArray(mode);
    const index = this._binarySearch(arr, time) - 1;
    if (index >= 0) {
      return arr[index];
    }
    return arr[arr.length - 1];
  }

  _findNextItem(time: Time, mode: string) {
    let arr = this._getTimingArray(mode);
    let index = this._binarySearch(arr, time);
    if (index >= arr.length) {
      return arr[0];
    }
    if (this._timeToInt(arr[index].time) === this._timeToInt(time)) {
      index++;
    }
    if (index >= arr.length) {
      return arr[0];
    }
    return arr[index];
  }

  private _getTimingArray(mode: string): TimingItem[] {
    if (mode === 'adaptive') {
      return this._timings;
    }
    return this._nightTimings;
  }

  _binarySearch(arr: TimingItem[], target: Time): number {
    let left = 0;
    let right = arr.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);

      if (arr[mid].time.hours === target.hours && arr[mid].time.minutes === target.minutes) {
        return mid;
      }
      if (this._timeToInt(arr[mid].time) < this._timeToInt(target)) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return left; // Return the index where the item is supposed to stay
  }


  _validateTiming(timing: string): boolean {
    if (timing === '') {
      return true;
    }

    let lastTime = -1;

    try {
      const parsedTiming: Timing = JSON.parse(timing);
      for (const time in parsedTiming) {
        if (!this._isValidTime(time)) {
          this.log(`Time value ${time} is not valid`);
          return false;
        }

        const tm = this._parseTime(time);

        const intTime = this._timeToInt(tm);
        if (intTime <= lastTime) {
          this.log(`Time value ${time} smaller than prev time`);
          return false;
        }

        lastTime = intTime;

        const value = parsedTiming[time];
        if (value.brightness !== 'circadian') {
          const brightness = parseFloat(value.brightness);

          if (isNaN(brightness) || brightness < 0 || brightness > 1) {
            return false;
          }
        }

        if (value.temperature !== 'circadian') {
          const temperature = parseFloat(value.temperature);
          if (isNaN(temperature) || temperature < 0 || temperature > 1) {
            return false;
          }
        }
      }
      return true;
    } catch (e) {
      this.log(e)
      return false;
    }
  }

  _isValidTime(time: string): boolean {
    const timeRegExp = /^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegExp.test(time);
  }

  _parseTiming(timing: any): TimingItem[] {
    if (!timing) {
      return [];
    }
    const rawTiming: Timing = JSON.parse(timing);
    const result: TimingItem[] = [];
    for (const time in rawTiming) {
      result.push(
        {
          time: this._parseTime(time),
          value: rawTiming[time]
        }
      )
    }
    return result;
  }

  _parseTime(time: string): Time {
    const [hoursStr, minutesStr] = time.split(':');
    const hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);

    return { hours, minutes };
  }
}

module.exports = CircadianTimingZone;