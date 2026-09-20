export interface DatasetInformation {
  description: string;
  visualization: string;
  sources: Array<{ label: string; url: string }>;
  legend?: Array<{ label: string; color: string }>;
}

const examples: Record<string, Omit<DatasetInformation, 'visualization'>> = {
  'road-safety': {
    description:
      'Locations of reported personal-injury road collisions in Great Britain. This local example contains 140,056 coordinate records.',
    sources: [
      {
        label: 'UK Department for Transport · road safety data',
        url: 'https://www.gov.uk/government/statistical-data-sets/road-safety-open-data',
      },
    ],
  },
  'bike-parking': {
    description:
      '2,520 San Francisco bicycle parking locations, with addresses, rack counts, and parking capacity. This is a historical SFMTA sample distributed by deck.gl.',
    sources: [
      {
        label: 'DataSF / SFMTA · bicycle parking racks',
        url: 'https://catalog.data.gov/dataset/bicycle-parking-racks',
      },
      {
        label: 'deck.gl · example snapshot',
        url: 'https://github.com/visgl/deck.gl-data/blob/master/website/sf-bike-parking.json',
      },
    ],
  },
  commute: {
    description:
      '679,643 residence-to-workplace connections in the United Kingdom. Each record links an origin and destination with a commuter count.',
    sources: [
      {
        label: 'ONS · origin–destination data reference',
        url: 'https://www.ons.gov.uk/census/2011census/2011censusdata/originanddestinationdata',
      },
    ],
  },
  'bart-ridership': {
    description:
      'The 60 busiest BART station pairs, covering 29 stations. August 2026 average weekday trips are combined across both travel directions.',
    sources: [
      { label: 'BART · ridership reports', url: 'https://www.bart.gov/about/reports/ridership' },
      {
        label: 'BART · August 2026 workbook',
        url: 'https://www.bart.gov/sites/default/files/2026-09/Ridership_202608.xlsx',
      },
      { label: 'BART · station coordinates / GTFS', url: 'https://www.bart.gov/schedules/developers/gtfs' },
    ],
    legend: [
      { label: 'Transbay', color: '#44d0e0' },
      { label: 'Same-side', color: '#f5b759' },
    ],
  },
  airports: {
    description:
      'A worldwide sample of 891 airports, with names, abbreviations, types, and coordinates. Distributed by deck.gl from Natural Earth airport data.',
    sources: [
      {
        label: 'Natural Earth · airports',
        url: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/airports/',
      },
      {
        label: 'deck.gl · example snapshot',
        url: 'https://github.com/visgl/deck.gl-data/blob/master/examples/line/airports.json',
      },
    ],
  },
  gun: {
    description:
      '136,700 US gun-violence incident records dated January 2013 through March 2018, with locations, reported deaths, injuries, and incident notes.',
    sources: [{ label: 'Gun Violence Archive · reference', url: 'https://www.gunviolencearchive.org/' }],
  },
  'cab-trips': {
    description:
      '996 preprocessed New York taxi paths and 999 building footprints from the deck.gl example. The trip sample covers June 16, 2016, 21:00–21:30.',
    sources: [
      {
        label: 'NYC Taxi & Limousine Commission · trip records',
        url: 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page',
      },
      { label: 'deck.gl · trips and building provenance', url: 'https://deck.gl/examples/trips-layer' },
      { label: 'OpenStreetMap · building data attribution', url: 'https://www.openstreetmap.org/copyright' },
    ],
  },
};

const visualizations: Record<string, string> = {
  hexagon:
    'Points are grouped into hexagonal cells. Taller cells and warmer colors indicate more records; the radius setting controls the area being summarized.',
  line: 'Straight lines join each record’s source and destination. Select a connection to frame its endpoints and path with the camera.',
  point:
    'Each dot marks one geographic location. Marker size is kept visible as you zoom and does not represent passenger volume or airport capacity.',
  mix: 'The heatmap summarizes reported deaths plus half the reported injuries. Red dots mark incidents with fatalities; orange dots mark other incidents.',
  animated:
    'Moving trails follow the prepared trip paths and timestamps. Two colors distinguish vendor groups; building footprints provide context. Trail length controls how much recent movement stays visible.',
};

export function getDatasetInformation(
  datasetId: string | undefined,
  visualizationId: string | undefined,
): DatasetInformation {
  const example =
    datasetId && Object.prototype.hasOwnProperty.call(examples, datasetId) ? examples[datasetId] : undefined;
  let visualization =
    visualizationId && Object.prototype.hasOwnProperty.call(visualizations, visualizationId)
      ? visualizations[visualizationId]
      : 'Geographic records are displayed on the map. Select a visible object to explore it with the camera.';
  if (datasetId === 'bart-ridership' && visualizationId === 'line') {
    visualization =
      'Thicker lines mean more weekday trips. Cyan marks transbay pairs; amber marks same-side pairs. Dots mark stations. Selecting a line fades other connections. Lines show passenger demand, not rail routes.';
  } else if (datasetId === 'commute' && visualizationId === 'line') {
    visualization =
      'Straight lines link residence and workplace locations. Brighter lines indicate larger commuter flows. These connections summarize travel demand, not the roads people take.';
  } else if (datasetId === 'bike-parking' && visualizationId === 'hexagon') {
    visualization =
      'Hexagons group nearby parking locations. Height and color count locations, not parking spaces or racks; the radius setting changes the area being summarized.';
  }
  return {
    ...(example ?? {
      description: datasetId?.startsWith('upload:')
        ? 'User-uploaded dataset. Its source, collection period, and background information have not been provided.'
        : 'This dataset has no recorded background information or source attribution.',
      sources: [],
    }),
    visualization,
  };
}
