import { SpotterEmbed } from './spotter-embed.js';
import { tableauConfig } from '../configs/tableau-config.js';
import { powerBiConfig } from '../configs/power-bi-config.js';

export { SpotterEmbed, tableauConfig, powerBiConfig };

export class TableauSpotterEmbed extends SpotterEmbed {
  constructor(hooks) {
    super(tableauConfig, hooks);
  }
}

export class PowerBiSpotterEmbed extends SpotterEmbed {
  constructor(hooks) {
    super(powerBiConfig, hooks);
  }
}
