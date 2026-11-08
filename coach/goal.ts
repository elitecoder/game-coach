/** A goal is an ordered set of coarse, visually-distinct waypoints. We deliberately
 *  key on high-contrast scene signatures (cave vs surface town vs structured cavern),
 *  not fine zone names — those are what the vision step gets wrong. */
export type Direction = "left" | "right" | "up" | "down" | "explore" | "talk" | "done";

export interface Waypoint {
  id: string;
  label: string;
  look: string; // distinctive visual signature for the vision judge
  direction: Direction; // where to go to LEAVE this waypoint toward the next
  hazard?: string; // known hazard on this leg → warned ANTICIPATORILY (latency-immune)
}

export interface Goal {
  id: string;
  title: string;
  waypoints: Waypoint[];
}

export const GOALS: Record<string, Goal> = {
  map: {
    id: "map",
    title: "Get the first area map",
    waypoints: [
      {
        id: "kings_pass",
        label: "King's Pass — head right",
        look: "a blue, misty underground CAVE / cliff interior; the small white horned Knight on stone ground; floating spores; NO buildings, NO night sky, NO other characters",
        direction: "right",
        hazard: "Spike pits — jump across from the edge, one clean jump. They cost 1 mask, not a life; don't spam-jump into them.",
      },
      {
        id: "dirtmouth",
        label: "Dirtmouth — drop down the well",
        look: "the SURFACE town at night: dark starry sky above, snow/pale ground, gravestones or wooden signposts, a round stone WELL in the middle, possibly a lone bug villager standing around",
        direction: "down",
      },
      {
        id: "crossroads",
        label: "Crossroads — find the mapmaker",
        look: "an underground cavern of carved BROWN/GREY structured stone platforms and arches; possibly orange infection blobs; bugs/enemies; NO night sky",
        direction: "explore",
      },
      {
        id: "cornifer",
        label: "Cornifer — talk & buy the map",
        look: "a rotund orange-and-white mapmaker NPC (Cornifer) sitting on the ground with a large map/papers; scattered white paper scraps nearby",
        direction: "talk",
      },
      {
        id: "done",
        label: "Map bought! 🎉",
        look: "a shop / purchase dialog box on screen, OR a small area map now shown in a corner of the HUD",
        direction: "done",
      },
    ],
  },
};
