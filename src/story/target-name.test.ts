import type { CameraMovement } from '../interfaces';
import { createPointTarget } from '../camera/selection';
import { preserveCameraMetadata } from '../camera/authoring';
import { derivePlaybackPlan } from './playback';
import { createStoryJson, parseStoryJson } from './serialization';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type NamedCamera = CameraMovement & { timelineTargetName?: string };
const view = { longitude: 0, latitude: 0, zoom: 8, pitch: 0, bearing: 0 };
const base: NamedCamera = {
  id: 'first',
  name: 'overview-static',
  title: 'Static shot',
  category: 'overview',
  initViewState: view,
  finalViewState: view,
  duration: 1000,
  stay: 0,
  isRotating: false,
  interpolationType: 'none',
  interpolationDuration: 0,
};
const name = '  开场 / Location <A> & B  ';

for (const targetSnapshot of [undefined, createPointTarget([0, 0])]) {
  const source: NamedCamera = { ...base, targetSnapshot, timelineTargetName: name };
  for (const trajectoryEnabled of [false, true]) {
    const options = { trajectoryEnabled, viewport: { width: 800, height: 600 } };
    const story = createStoryJson([source], options);
    for (const value of story.version === 1 ? [story, story.cameras] : [story]) {
      const imported = parseStoryJson(JSON.parse(JSON.stringify(value)));
      assert(imported.ok, 'renamed Story must import in every supported format');
      assert(
        (imported.cameras[0] as NamedCamera).timelineTargetName === name,
        'import/export preserves exact target name',
      );
      const plan = derivePlaybackPlan(imported.cameras, options);
      assert(plan.timelineData[0].name === name, 'Timeline rebuild displays the saved target name');
      assert(plan.totalTime === 1000, 'renaming preserves timing');
      assert(
        JSON.stringify(createStoryJson(imported.cameras, options)) === JSON.stringify(story),
        're-export keeps the name and trajectory unchanged',
      );
    }
  }
  const applied = preserveCameraMetadata(source, base) as NamedCamera;
  assert(applied.timelineTargetName === name, 'applying camera changes retains the user name');
}

const oldStory = parseStoryJson(JSON.parse(JSON.stringify(createStoryJson([base]))));
assert(oldStory.ok, 'old stories without a custom name remain valid');
assert(
  derivePlaybackPlan(oldStory.cameras).timelineData[0].name === 'Current view',
  'old stories retain the default name',
);
assert(
  !parseStoryJson({ type: 'geo-camera-story', version: 1, cameras: [{ ...base, timelineTargetName: 42 }] }).ok,
  'non-text names are rejected',
);
console.log('Timeline target names survive Story V1, V2, legacy import, and camera reapplication.');
