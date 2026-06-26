export function collectCellComponent(cells, first) {
  const queue = [first];
  const component = [];
  cells.delete(first);

  while (queue.length) {
    const key = queue.pop();
    const [x, z] = key.split(":").map(Number);
    component.push([x, z]);
    for (const neighbor of neighbors4(x, z)) {
      const neighborKey = `${neighbor[0]}:${neighbor[1]}`;
      if (cells.delete(neighborKey)) {
        queue.push(neighborKey);
      }
    }
  }

  return component;
}

function neighbors4(x, z) {
  return [
    [x + 1, z],
    [x - 1, z],
    [x, z + 1],
    [x, z - 1],
  ];
}
